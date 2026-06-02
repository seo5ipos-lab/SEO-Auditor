const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const adapter = new FileSync('db.json');
const db = low(adapter);

// Полная структура БД по ТЗ
db.defaults({
    settings: {
        openRouterKey: '',
        endpoint: 'https://openrouter.ai/api/v1',
        wordstatKey: '',
        systemPrompt: 'Сделай краткий SEO-анализ. Верни список доменов конкурентов.'
    },
    projects: [],
    tasks: [],
    queries: [],
    responses: []
}).write();

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC Мосты для настроек и проектов
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

// Сохранение результатов сессии
ipcMain.on('save-session-results', (event, data) => {
    db.get('tasks').push(data.task).write();
    data.queries.forEach(q => db.get('queries').push(q).write());
    data.responses.forEach(r => db.get('responses').push(r).write());
});