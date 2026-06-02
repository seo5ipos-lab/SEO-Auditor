const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

let db;

function initDB() {
    // Сохраняем БД в надежном системном каталоге AppData, чтобы данные не стирались
    const dbPath = path.join(app.getPath('userData'), 'seo-auditor-db.json');
    const adapter = new FileSync(dbPath);
    db = low(adapter);

    db.defaults({
        settings: {
            openRouterKey: '',
            wordstatKey: '',
            systemPrompt: 'Сделай краткий SEO-анализ по этим агрегированным данным. Выдели главные угрозы со стороны конкурентов.'
        },
        projects: []
    }).write();
}

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1300,
        height: 900,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
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

// --- IPC Мосты ---
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