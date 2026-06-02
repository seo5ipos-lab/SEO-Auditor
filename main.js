const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

// Настройка базы данных lowdb
const adapter = new FileSync('db.json');
const db = low(adapter);

// Задаем структуру базы данных по умолчанию (строго по ТЗ)
db.defaults({
    settings: {
        openRouterKey: '',
        endpoint: 'https://openrouter.ai/api/v1',
        wordstatKey: '',
        systemPrompt: 'Сделай краткий SEO-анализ на основе собранных данных.'
    },
    projects: [],
    tasks: [],
    queries: [],
    responses: []
}).write();

let mainWindow;

function createWindow() {
    // Создаем главное окно приложения
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false // Для простоты сборки и связки frontend/backend
        }
    });

    // Загружаем визуальный интерфейс
    mainWindow.loadFile('index.html');
    
    // mainWindow.webContents.openDevTools(); // Позже раскомментируем для поиска ошибок
}

// Запуск окна, когда Electron готов к работе
app.whenReady().then(createWindow);

// Закрытие процесса при закрытии всех окон (стандарт для Windows)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// --- Блок связи (IPC) между визуальным интерфейсом и базой данных ---

// Интерфейс просит выдать текущие настройки
ipcMain.handle('get-settings', () => {
    return db.get('settings').value();
});

// Интерфейс просит сохранить новые настройки
ipcMain.on('save-settings', (event, newSettings) => {
    db.set('settings', newSettings).write();
});
