let request;
try {
    request = require('supertest');
} catch (err) {
    request = require('./helpers/supertest');
}
let app;
try {
    app = require('../app'); // Adjust the path to your app entry point
} catch (err) {
    app = { _router: { stack: [] } };
}
const fs = require('fs');
const path = require('path');

async function getChai() {
    const chai = await import('chai');
    return chai;
}

function getRoutes(app) {
    const routes = [];
    if (app._router && app._router.stack) {
        app._router.stack.forEach((middleware) => {
            if (middleware.route) { // routes registered directly on the app
                routes.push({
                    path: middleware.route.path,
                    methods: middleware.route.methods,
                    controller: middleware.handle.name || 'anonymous',
                    file: getFilePath(middleware.handle)
                });
            } else if (middleware.name === 'router' && middleware.handle.stack) { // router middleware
                middleware.handle.stack.forEach((handler) => {
                    const route = handler.route;
                    route && routes.push({
                        path: route.path,
                        methods: route.methods,
                        controller: handler.handle.name || 'anonymous',
                        file: getFilePath(handler.handle)
                    });
                });
            }
        });
    }
    return routes;
}

function getFilePath(fn) {
    const match = fn.toString().match(/at (.+):\d+:\d+/);
    return match ? match[1] : 'unknown';
}

function logToFile(message, filePath = 'unknown') {
    const logFilePath = path.join(__dirname, 'routes_test.log');
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\nFile: ${filePath}\n`;

    // Ensure the log file exists
    if (!fs.existsSync(logFilePath)) {
        fs.writeFileSync(logFilePath, '', 'utf8');
    }

    fs.appendFileSync(logFilePath, '=========================\n', 'utf8');
    fs.appendFileSync(logFilePath, logMessage, 'utf8');
    fs.appendFileSync(logFilePath, '=========================\n', 'utf8');
}

describe('Route Tests', function() {
    let expect;

    before(async function() {
        const chai = await getChai();
        expect = chai.expect;
    });

    it('should find routes in the application', function() {
        const routes = getRoutes(app);

        if (routes.length === 0) {
            logToFile('No routes found in the application.');
        } else {
            logToFile('Found routes: ' + routes.map(route => `${route.path} (Controller: ${route.controller})`).join(', '));
        }

        expect(routes.length).to.be.greaterThan(0);
    });

    const routes = getRoutes(app);

    routes.forEach((route) => {
        const methods = Object.keys(route.methods);
        methods.forEach((method) => {
            it(`should respond to ${method.toUpperCase()} ${route.path}`, function(done) {
                let path = route.path;

                // Replace dynamic parameters with sample values
                path = path.replace(/:client/g, 'sampleClient')
                           .replace(/:contact/g, 'sampleContact')
                           .replace(/:invoice/g, 'sampleInvoice')
                           .replace(/:quote/g, 'sampleQuote')
                           .replace(/:subcontractor/g, 'sampleSubcontractor')
                           .replace(/:user/g, 'sampleUser')
                           .replace(/:jobId/g, 'sampleJobId')
                           .replace(/:locationId/g, 'sampleLocationId')
                           .replace(/:attendance/g, 'sampleAttendance')
                           .replace(/:employee/g, 'sampleEmployee')
                           .replace(/:uuid/g, 'sampleUuid')
                           .replace(/:id/g, 'sampleId')
                           .replace(/:year/g, '2025')
                           .replace(/:month/g, '01')
                           .replace(/:date/g, '2025-01-21')
                           .replace(/:week/g, '1')
                           .replace(/:filename/g, 'sampleFilename');

                logToFile(`Testing ${method.toUpperCase()} ${path} (Controller: ${route.controller})`, route.file);
                request(app)[method](path)
                    .expect(200)
                    .end(function(err, res) {
                        if (err) {
                            logToFile(`Error testing ${method.toUpperCase()} ${path} (Controller: ${route.controller}): ${err.message}`, route.file);
                            return done(err);
                        }
                        logToFile(`Success testing ${method.toUpperCase()} ${path} (Controller: ${route.controller})`, route.file);
                        done();
                    });
            });
        });
    });
});