# Repository Guidelines

- Use Node.js 16 or newer.
- Install dependencies with `npm install`.
- Run the unit tests with `npm test` before committing.
- If you modify files in the `e2e/` folder, run the end-to-end tests with `npx playwright test`.
- Ensure `git status` reports a clean working tree before you finish.
- Use git bash as terminal
- trace from app.js that the file is included at some point, or is a child of another file that is included in the app.js file
- do not use \mongoose\views\mongoose
- do use \mongoose\views\tailwindcss
- The `kashflowAPI/` folder is unused. Data sync is handled by [github.com/cappytech/hcs-sync](https://github.com/cappytech/hcs-sync).
