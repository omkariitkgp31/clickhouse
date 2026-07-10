const { ingest, ingestBulk } = require("../services/telemetryService");
const bufferService = require("../services/bufferService");

exports.ingestTelemetry = async (req, res) => {//req-> stores everything that comes from the client, res-> response to the client
    try {
        ingest(req.body);

        res.status(200).json({
            success: true,
            message: "Telemetry buffered",//this means that the data sent by the client has been successfully received and stored in a temporary buffer for further processing
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({
            success: false,
            error: err.message,
            details: err.details
        });
    }
};

exports.ingestBulkTelemetry = async (req, res) => {
    try {
        const packets = req.body;

        if (!Array.isArray(packets)) {//checks if the request body is an array of telemetry packets. If not, it returns a 400 Bad Request response with an error message indicating that the body must be a JSON array of telemetry packets.
            return res.status(400).json({
                success: false,
                error: "Body must be a JSON array of telemetry packets",
            });
        }

        const { inserted, failed } = ingestBulk(packets);//this line calls the ingestBulk function from the telemetryService, passing in the array of telemetry packets. The function returns an object containing the number of successfully inserted records and an array of failed records.

        // 207 Multi-Status: partial success (some records were invalid)
        const status = failed.length > 0 && inserted === 0 ? 400
            : failed.length > 0 ? 207//if some successful records were inserted but some failed, it returns a 207 Multi-Status response. If all records were successfully inserted, it returns a 200 OK response.
                : 200;

        return res.status(status).json({//this makes and json response to the client with the status code determined above. 
            success: inserted > 0,//if the numer of success is >0 this 1 or true, if not it is 0 or false
            message: `${inserted} record(s) buffered, ${failed.length} failed`,
            inserted,
            failed: failed.length > 0 ? failed : undefined,//numebr of failed records, if there are no failed records, it will be undefined
        });
    } catch (err) {
        res.status(err.statusCode || 500).json({// this 'err.statusCode || 500" if there is a specific status code in the error object, it will use that, otherwise it will default to 500 (Internal Server Error)
            success: false,
            error: err.message,
        });
    }
};

exports.getBufferSize = (req, res) => {
    res.json({
        size: bufferService.getBuffer().length//returns the current size in O(1) time complex 
    });
};

exports.getTelemetry = async (req, res) => {
    try {
        const { deviceId, from, to, limit, offset } = req.query;

        const telemetry = await telemetryService.getTelemetry(//await is used to wait for the asynchronous operation to complete before proceeding. This ensures that the telemetry data is retrieved before sending the response back to the client.
            deviceId,
            from,
            to,
            limit,
            offset
        );//here is this object it calls for the getTelemetry function from the telemetryService, passing in the query parameters received from the client. The function retrieves telemetry data based on the specified criteria.

        res.status(200).json({
            success: true,
            data: telemetry
        });//if succeded, it sends a 200 OK response with the retrieved telemetry data in JSON format. The response includes a success flag set to true and the telemetry data itself.
    } catch (err) {//if an err is found then 400 is used for that is uses the err.message to send back to the client in the response. This allows the client to understand what went wrong and take appropriate action.
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
};
