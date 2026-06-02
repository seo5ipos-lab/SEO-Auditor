const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

let db;

function initDB() {
    const dbPath = path.join(app.getPath('userData'), 'seo-auditor-db.json');
    const adapter = new FileSync(dbPath);
    db = low(adapter);

    db.defaults({
        settings: {
            openRouterKey: '',
            yandexToken: '',
            systemPrompt: 'Сделай краткий SEO-анализ по этим агрегированным данным. Оцени динамику видимости. Выдели главные угрозы со стороны конкурентов.',
            favorites: []
        },
        projects: []
    }).write();
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: false
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
    initDB();
    createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// Простое открытие окна без парсинга (пользователь копирует сам)
ipcMain.handle('open-search-browser', async (event, data) => {
    const { engine, query } = data;
    let parserWin = new BrowserWindow({
        width: 1200, height: 800, show: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const url = engine === 'google-ai'
        ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
        : `https://yandex.ru/search/?text=${encodeURIComponent(query)}`;

    parserWin.loadURL(url);
    return true; 
});

ipcMain.handle('get-settings', () => db.get('settings').value());
ipcMain.on('save-settings', (event, newSettings) => { db.set('settings', newSettings).write(); });

ipcMain.handle('get-projects', () => db.get('projects').value());
ipcMain.on('save-project', (event, project) => {
    const projects = db.get('projects');
    if (projects.find({ id: project.id }).value()) {
        projects.find({ id: project.id }).assign(project).write();
    } else {
        projects.push(project).write();
    }
});
ipcMain.on('delete-project', (event, projectId) => {
    db.get('projects').remove({ id: projectId }).write();
});