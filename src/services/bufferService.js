const buffer = [];//this addes the buffer array to store the telemetry packets in memory (RAM). It is used to temporarily hold the telemetry data before it is processed or sent to a database. The buffer allows for efficient handling of incoming telemetry packets, enabling batch processing and reducing the number of database writes.

function add(packet) {
    buffer.push(packet);
}

function getBuffer() {
    return buffer;
}

function peek(limit = buffer.length) {
    return buffer.slice(0, limit);
}

function remove(count) {
    return buffer.splice(0, count);
}

function flush(limit = buffer.length) {//used for the batch insert job, it removes the specified number of packets from the buffer and returns them for further processing. If no limit is provided, it removes all packets from the buffer.
    return buffer.splice(0, limit);
}

module.exports = {
    add,
    getBuffer,
    peek,
    remove,
    flush,
};
