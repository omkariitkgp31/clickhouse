const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function toDate(value) {
    if (value instanceof Date) {
        return value;
    }

    if (typeof value === "string" && value.includes(" ") && !value.includes("T")) {
        return new Date(`${value.replace(" ", "T")}Z`);
    }

    return new Date(value);
}

function normalizeUtc(value) {
    return toDate(value).toISOString();
}

function isBefore(start, end) {
    return toDate(start).getTime() < toDate(end).getTime();
}

function getWindowBounds(timestamp, windowSizeMs = FIFTEEN_MINUTES_MS) {
    const time = toDate(timestamp).getTime();

    const windowStart = new Date(
        Math.floor(time / windowSizeMs) * windowSizeMs
    );

    const windowEnd = new Date(
        windowStart.getTime() + windowSizeMs
    );

    return {
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString()
    };
}

module.exports = {
    FIFTEEN_MINUTES_MS,
    getWindowBounds,
    isBefore,
    normalizeUtc,
    toDate
};
