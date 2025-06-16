# SMS Application

This project is a web application for managing subcontractors. It requires Node.js and npm.

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

## Running Tests

1. Install dependencies:
   ```bash
   npm install
   ```
2. Run the test suite with Mocha:
   ```bash
   npm test
   ```
   or directly execute the test file:
   ```bash
   node test/routes.test.js