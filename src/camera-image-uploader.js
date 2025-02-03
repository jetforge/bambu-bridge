export default class CameraImageUploader {

	constructor({client, printerId, axiosInstance}) {
		this.client = client;
		this.printerId = printerId;
		this.axiosInstance = axiosInstance;
		this.uploadTimeout = setTimeout(() => {
			this.upload();
		}, 5000);
	}

	async upload() {
		let image = null;
		try {
			// console.log("getting image for " + this.printerId);
			image = await this.client.getCurrentImage();
		} catch (error) {
			// console.log("error fetching image from printer " + this.printerId);
			// console.log(error);
		}

		if (image) {
			this.axiosInstance.post("/camera", {
				printer_id: this.printerId,
				image: image.toString('base64')
			})
				.then(() => {
					// console.log("image uploaded");
				})
				.catch(error => {
					// console.log(error);
				});
		}

		this.uploadTimeout = setTimeout(() => {
			this.upload();
		}, 5000);
	}

	finish() {
		clearTimeout(this.uploadTimeout);
	}


}