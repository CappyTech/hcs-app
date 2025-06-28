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

Running all tests including unit, end-to-end and stress tests:
```bash
npm test
```

You can run only the end-to-end tests with:
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

See the [LICENSE](LICENSE) file for license information.

## Roadmap

Upcoming features planned for future releases:
- Allow for Subcontractor users to see their own data.
- Allow for Client users to see their own data.
- Allow for Employee users to see their own data.
- Allow for Manager Employees users to manage their assigned employees.
- Allow for Accountant users to come in and do their work.
- Allow for HMRC users to audit the system.
- Allow for Admin users to manage the system.
- Allow for Super Admin users to manage the system and all users.
- Make routes /role/* the primary route for each user role.
- Ensure 2FA works
