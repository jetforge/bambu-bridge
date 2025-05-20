import axios from "axios";
import BambuClient from "./bambu-client.js";
import CameraImageUploader from "./camera-image-uploader.js";

const updateInterval = 5000;

export default class Worker {

	constructor(settings) {

		//region init axios with authorization header and base url from settings.api_base_url and settings.api_access_token
		this.axiosInstance = axios.create({
			baseURL: settings.api_base_url,
			timeout: 5000,
			headers: {
				Authorization: `Bearer ${settings.api_key}`
			}
		});
		//endregion

		this.init();

		this.clients = { };

		this.imageUploaders = { };

		this.statuses = { };

		this.errors = { };

	}

	init() {
		//region make init request to the api
		this.axiosInstance.post("/init", {})
			.then(response => {
				response.data.printers.forEach(printer => {
					this.initClient(printer);
				});

				setInterval(async () => this.update(), updateInterval);
				console.log('init success');
			})
			.catch(error => {
				console.log('init error, will retry');
				setTimeout(() => this.init(), 30000);
			});
		//endregion
	}


	initClient(printer) {
		console.log("init client for " + printer.id);
		this.clients[printer.id] = new BambuClient({
			host: printer.options.host,
			accessToken: printer.options.access_token,
			serialNumber: printer.options.serial_number,
			model: printer.model,
			onPrintMessage: message => {
				this.statuses[printer.id] = {
					state: message.state.toLowerCase(),
					progress: message.progress,
					remaining_time: message.remainingTime,
					file_name: message.file,
					bed_temperature: message.bedTemperature,
					ams: message.ams,
					total_layers: message.totalLayers,
					current_layer: message.currentLayer,
					print_error: message.printError,
					filament_sensor: message.filamentSensor
				};
			},
			onDisconnect: () => {
				delete this.statuses[printer.id];
			}
		});

		this.imageUploaders[printer.id] = new CameraImageUploader({client: this.clients[printer.id], printerId: printer.id, axiosInstance: this.axiosInstance});
	}

	removeClient(printerId) {
		this.clients[printerId].finish();
		delete this.clients[printerId];
		this.imageUploaders[printerId].finish();
		delete this.imageUploaders[printerId];
		delete this.statuses[printerId];
	}

	async update(){

		let printers = {};

		for (const printerId in this.statuses) {
			const error = this.errors[printerId] || null;

			printers[printerId] = {
				...this.statuses[printerId],
				error
			};
		}

		this.errors = {};

		this.axiosInstance.post("/update", printers)
			.then(response => {
				for (const command of response.data.commands) {
					if (command.command === "start") {
						const buffer = Buffer.from(command.fileData, 'base64');
						this.clients[command.printerId].uploadFile(command.fileName, buffer)
							.then(() => {
								console.log("file uploaded");
								this.clients[command.printerId].print({name: command.fileName, trays: command.trays, param: command.gcodeFile});
							})
							.catch(error => {
								console.log('upload error');
								this.errors[command.printerId] = 'UPLOAD_FAILED';
							});
					}

					if (command.command === "stop") {
						this.clients[command.printerId].stop();
					}
				}

				for (const printer of response.data.printers) {
					if (!this.clients[printer.id]) {
						this.initClient(printer);
						continue;
					}

					if (this.clients[printer.id].accessToken !== printer.options.access_token) {
						console.log("removing due to access token change for " + printer.id);
						console.log("old access token: " + this.clients[printer.id].accessToken);
						console.log("new access token: " + printer.access_token);
						this.removeClient(printer.id);
						continue;
					}

					if (this.clients[printer.id].host !== printer.options.host) {
						console.log("removing due to host change for " + printer.id);
						this.removeClient(printer.id);
						continue;
					}

					if (this.clients[printer.id].serialNumber !== printer.options.serial_number) {
						console.log("removing due to serial number change for " + printer.id);
						this.removeClient(printer.id);
						continue;
					}

					if (this.clients[printer.id].model !== printer.model) {
						console.log("removing due to model change for " + printer.id);
						this.removeClient(printer.id);
						continue;
					}


				}

				for (const printerId in this.clients) {
					const printer = response.data.printers.find(printer => printer.id == printerId);

					if (!printer) {
						this.removeClient(printerId);
					}
				}



			})
			.catch(error => {
			});
	}
}