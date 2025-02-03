#!/usr/bin/env node

import Worker from "./worker.js";


const settings = {
	api_base_url: "https://my.jetforge.app/api/bridge/bambu",
	api_key: process.env.API_KEY,
};

new Worker(settings);
