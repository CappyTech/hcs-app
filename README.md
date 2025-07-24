# SMS Application

This project is a web application for managing subcontractors. It requires Node.js and npm.

## Features

- Track subcontractor information, jobs and invoices
- Automate monthly CIS/HMRC returns
- User authentication with optional TOTP
- MongoDB and MariaDB support via migration scripts
- REST API documentation via Swagger


## Installation

1. Install [Node.js](https://nodejs.org/) (version 16 or later).
2. Install dependencies:
   ```bash
   npm install
   ```

## Configuration

Environment variables are loaded from a `.env` file in the project root. Copy the provided `.env.example` to `.env` and update the values for your environment:

```bash
cp .env.example .env
```

Important variables include database connection details, session secrets and API keys. See `.env.example` for the full list.

## Running the Application

To start the server in development mode with automatic restarts:

```bash
npm run dev
```

To run the app normally:

```bash
npm start
```

The server will start and log the port in the console. Access the application with your browser at the configured host and port.

## Testing

Mocha unit tests can be executed with:
```bash
npm test
```

End-to-end tests run with Playwright:
```bash
npx playwright test
```

You can also execute a single test file:
```bash
node test/routes.test.js
```

## API Documentation

Swagger UI is available at `/api-docs` once the server is running.

## License

This project is released under the license specified in `package.json`.


## Known Issues

Task show wrong date.

npx @tailwindcss/cli -i ./public/styles.css -o ./public/output.css --watch