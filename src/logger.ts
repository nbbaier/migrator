import pino from "pino";

const logger = pino({
	level: process.env.PINO_LOG_LEVEL || "trace",
	transport: {
		targets: [
			{
				level: "info",
				target: "pino-pretty",
				options: {
					colorize: true,
				},
			},
			{
				level: "error",
				target: "pino/file",
				options: {
					destination: "./logs/error.log",
					append: true,
				},
			},
			{
				level: "trace",
				target: "pino/file",
				options: {
					destination: "./logs/all.log",
					append: true,
				},
			},
		],
	},
});

export default logger;
