import mqtt from "mqtt";
import ftp from "basic-ftp";
const updateInterval = 15000;
import {Readable} from "stream";
import tls from 'tls';
import struct from 'python-struct';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';

export default class BambuClient {


	constructor({ host, accessToken, serialNumber, onPrintMessage, model }) {
		this.host = host;
		this.accessToken = accessToken;
		this.serialNumber = serialNumber;
		this.model = model;

		this.jpegStart = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
		this.jpegEnd = Buffer.from([0xff, 0xd9]);

		this.mqttClient = mqtt.connect(`mqtts://${host}:8883`, {
			username: "bblp",
			password: accessToken,
			reconnectPeriod: 1000,
			connectTimeout: 2000,
			keepalive: 60,
			resubscribe: true,
			rejectUnauthorized: false,
		});

		this.mqttClient.on("connect", async (...args) => {
			console.log(this.host + " connected");

			this.mqttClient.subscribe(`device/${serialNumber}/report`, (error) => {
				if (error) {
					// console.log(`Error subscribing`)
				}
			});

			this.getVersion();
		});



		this.mqttClient.on("disconnect", async (...args) => {
			console.log(this.host + " disconnected");
			this.onDisconnect?.();
			if (typeof this.pushInterval !== "undefined") {
				clearInterval(this.pushInterval);
				this.pushInterval = undefined;
			}
		});


		this.mqttClient.on("message", (topic, message) => {
			const payload = JSON.parse(message.toString());

			if (payload.info) {
				const otaModule = payload.info.module.find(module => module.name === "ota")

				const serialPrefix = otaModule.sn.substring(0, 3);

				let model = "X1C";

				switch (serialPrefix) {
					case "00M":
						model = "X1C";
						break;
					case "00W":
						model = "X1";
						break;
					case "03W":
						model = "X1E";
						break;
					case "01S":
						model = "P1P";
						break;
					case "01P":
						model = "P1S";
						break;
					case "030":
						model = "A1";
						break;
					case "039":
						model = "A1M";
						break;
				}

				if ([ "P1S", "P1P", "A1", "A1M" ].includes(model)) {
					if (typeof this.pushInterval === "undefined") {
						this.pushInterval = setInterval(() => {
							this.pushAll();
						}, updateInterval);
					}
					this.pushAll();
				}

				return;

			}



			if (!payload.print) {
				return;
			}

			if (typeof payload.print.gcode_state === "undefined") {
				return;
			}

			this.onPrintMessage?.({
				state: payload.print.gcode_state,
				progress: payload.print.mc_percent,
				remainingTime: payload.print.mc_remaining_time,
				file: payload.print.gcode_file,
				bedTemperature: payload.print.bed_temper,
				nozzleTemperature: payload.print.nozzle_temper,
				ams: payload.print?.ams?.ams ?? [],
				totalLayers: payload.print?.total_layer_num ?? 0,
				currentLayer: payload.print?.layer_num ?? 0,
				printError: payload.print?.print_error,
				filamentSensor: payload.print?.hw_switch_state === 1
			});

		});


		this.serialNumber = serialNumber;

		this.onPrintMessage = onPrintMessage;
	}


	createAuthPayload() {
		return Buffer.concat([
			struct.pack('<I', 0x40),
			struct.pack('<I', 0x3000),
			struct.pack('<I', 0),
			struct.pack('<I', 0),
			Buffer.from('bblp'.padEnd(32, '\0'), 'ascii'),
			Buffer.from(this.accessToken.padEnd(32, '\0'), 'ascii')
		]);
	}

	async getCurrentImage() {
		if (this.model === "A1" || this.model === "P1S") {
			return this.grabStaticImage();
		}
		if (this.model === "X1C") {
			return this.grabRTSPImage();
		}
	}

	async grabRTSPImage() {
		return new Promise((resolve, reject) => {
			const rtspUrl = `rtsps://bblp:${this.accessToken}@${this.host}:322/streaming/live/1`;

			const ffmpegCommand = ffmpeg(rtspUrl)
				.inputOptions('-rtsp_transport', 'tcp') // Ensures FFmpeg uses TCP for RTSP
				.inputOptions('-timeout', '5000000')
				.outputOptions('-frames:v', '1') // Capture only 1 frame
				.outputOptions('-q:v', '2') // Max JPEG quality (qscale: 2 is high quality, lower values mean higher quality)
				.format('mjpeg');

			const stream = new PassThrough(); // Stream to collect the JPEG output

			ffmpegCommand
				.on('error', (err) => {
					// console.error("Error capturing frame:", err);
					reject(err);
				})
				.on('close', () => {
					console.log('FFmpeg process closed.');
				})
				.pipe(stream, { end: true });

			let imgData = [];

			stream.on('data', (chunk) => {
				imgData.push(chunk);
			});

			const timeout = setTimeout(() => {
				reject(new Error('Operation timed out'));
				ffmpegCommand.kill(); // Terminate FFmpeg process
				stream.destroy(); // Destroy the stream
			}, 10000);

			stream.on('end', () => {
				clearTimeout(timeout);
				const buffer = Buffer.concat(imgData);
				const base64Image = buffer.toString('base64');
				resolve(base64Image);
				stream.destroy();
			});



		});
	}

	async grabStaticImage() {
		return new Promise((resolve, reject) => {
			//console.log("connecting");

			const socket = tls.connect(
				{
					host: this.host,
					port: 6000,
					rejectUnauthorized: false,
					timeout: 5000,
				},
				() => {
					const authData = this.createAuthPayload();
					socket.write(authData);  // Send authentication payload
				}
			);

			//console.log("connected");

			let imgBuffer = null;
			let payloadSize = 0;

			socket.on('data', (data) => {
				if (imgBuffer && imgBuffer.length < payloadSize) {
					imgBuffer = Buffer.concat([imgBuffer, data]);
					if (imgBuffer.length >= payloadSize) {
						socket.end();
						if (
							imgBuffer.slice(0, 4).equals(this.jpegStart) &&
							imgBuffer.slice(-2).equals(this.jpegEnd)
						) {
							resolve(imgBuffer.toString('base64')); // Return image as base64 string
						} else {
							reject(new Error("JPEG format error: Missing start or end markers"));
						}
					}
				} else if (data.length === 16) {
					payloadSize = data.readUInt32LE(0);
					imgBuffer = Buffer.alloc(0);
				} else {
					reject(new Error("Unexpected data format received"));
					socket.end();
				}
			});

			socket.on('error', (err) => {
				// console.error("Socket error:", err.message);
				reject(err);
			});
		});
	}



	getVersion() {
		this.publish({
			info: {
				command: "get_version"
			}
		});
	}

	pushAll() {
		this.publish({
			pushing: {
				command: "pushall"
			}
		});
	}

	publish(message) {
		this.mqttClient.publish(`device/${this.serialNumber}/request`, JSON.stringify(message), error => {
			if (error) {
				// console.log("publish error", error);
			}
		});
	}

	finish() {
		this.disconnect();
		if (typeof this.pushInterval === "undefined") {
			clearInterval(this.pushInterval);
		}
	}

	disconnect() {
		this.mqttClient.end();
	}

	async uploadFile(name, data) {
		const client = new ftp.Client(1800 * 1000);
		client.ftp.verbose = true;

		await client.access({
			host: this.host,
			port: 990,
			user: "bblp",
			password: this.accessToken,
			secure: 'implicit',
			secureOptions: {
				rejectUnauthorized: false
			},
		});

		const stream = new Readable();
		stream.push(data);
		stream.push(null);

		await client.uploadFrom(stream, name);

		client.close();
	}

	print({name, trays, param}) {
		//TODO p1, x1, ams (tested with a1)

		// console.log("printing " + name)

		const command = {
			"print": {
				"sequence_id":    "0",
				"command":        "project_file",
				"project_id":     "0",
				"profile_id":     "0",
				"task_id":        "0",
				"subtask_id":     "0",
				"param": param,
				"subtask_name":   name.replace('.3mf', '').replace('.gcode', ''),
				"url":            `ftp:///${name}`,
				"timelapse":      false,
				"bed_leveling":  true,
				"use_ams":        trays.length > 0,
				"bed_type":       "auto",
				"ams_mapping":    trays,
				"flow_cali":      false,
				"layer_inspect":  false,
				// "vibration_cali": false,
				// "ams_mapping":    [7, 2] //Purple & White (Gray Skull)
			}
		};

		// console.log(command);

		this.publish(command);


	}

	stop() {
		// console.log("stopping print");

		this.publish({
			"print": {
				"command": "stop",
				"param": "",
				"sequence_id": "0",
				"reason": "failed",
				"result": "failed"
			}
		});
	}
}