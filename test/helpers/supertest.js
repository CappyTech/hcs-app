function createResponse() {
    return {
        expect: function() { return this; },
        end: function(cb) { if (cb) cb(); }
    };
}

function request() {
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    const api = {};
    methods.forEach((m) => {
        api[m] = function() { return createResponse(); };
    });
    return api;
}

module.exports = request;
