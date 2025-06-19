const { test, expect } = require('@playwright/test');
const express = require('express');
const session = require('express-session');
let server;

// Simple in-memory store
const users = [];
const tasks = [];

// HTML helpers
function registrationForm() {
  return `<!DOCTYPE html>
  <html><body>
  <form action="/user/register" method="POST">
    <input type="text" name="username" />
    <input type="email" name="email" />
    <input type="password" name="password" />
    <button type="submit">Register</button>
  </form>
  </body></html>`;
}

function loginForm() {
  return `<!DOCTYPE html>
  <html><body>
  <form action="/user/login" method="POST">
    <input type="text" name="username" />
    <input type="password" name="password" />
    <button type="submit">Login</button>
  </form>
  </body></html>`;
}

function taskForm() {
  return `<!DOCTYPE html>
  <html><body>
  <form action="/task/create" method="POST">
    <input type="text" name="title" />
    <textarea name="description"></textarea>
    <button type="submit">Create Task</button>
  </form>
  </body></html>`;
}

test.beforeAll(() => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));

  app.get('/user/register', (req, res) => res.send(registrationForm()));
  app.post('/user/register', (req, res) => {
    users.push({ username: req.body.username, email: req.body.email, password: req.body.password });
    res.redirect('/user/login');
  });

  app.get('/user/login', (req, res) => res.send(loginForm()));
  app.post('/user/login', (req, res) => {
    const user = users.find(u => u.username === req.body.username && u.password === req.body.password);
    if (user) {
      req.session.user = user;
      return res.redirect('/task/create');
    }
    res.redirect('/user/login');
  });

  app.get('/task/create', (req, res) => {
    if (!req.session.user) return res.redirect('/user/login');
    res.send(taskForm());
  });
  app.post('/task/create', (req, res) => {
    if (!req.session.user) return res.status(401).send('Unauthorized');
    tasks.push({ title: req.body.title, description: req.body.description });
    res.redirect('/tasks');
  });

  app.get('/tasks', (req, res) => res.json(tasks));

  server = app.listen(3001);
});

test.afterAll(() => {
  server.close();
});

test('user registration, login and task creation', async ({ page }) => {
  await page.goto('http://localhost:3001/user/register');
  await page.fill('input[name="username"]', 'testuser');
  await page.fill('input[name="email"]', 'test@example.com');
  await page.fill('input[name="password"]', 'password');
  await page.click('button[type="submit"]');

  await page.waitForURL('http://localhost:3001/user/login');
  await page.fill('input[name="username"]', 'testuser');
  await page.fill('input[name="password"]', 'password');
  await page.click('button[type="submit"]');

  await page.waitForURL('http://localhost:3001/task/create');
  await page.fill('input[name="title"]', 'Sample Task');
  await page.fill('textarea[name="description"]', 'Task description');
  await page.click('button[type="submit"]');

  await page.waitForURL('http://localhost:3001/tasks');
  const body = await page.textContent('body');
  expect(body).toContain('Sample Task');
});
