function toBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }

    if (value === 1 || value === "1" || value === "true") {
        return true;
    }

    if (value === 0 || value === "0" || value === "false") {
        return false;
    }

    return null;
}

module.exports = {
    toBoolean
};
