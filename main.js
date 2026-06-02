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
            systemPrompt: 'Сделай краткий SEO-анализ по этим агрегированным данным. Оцени динамику видимости. Выдели главные угрозы со стороны конкурентов.'
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
            webSecurity: false // Отключено для обхода CORS в Wordstat API
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

// Нативный парсер для Google и Яндекс
ipcMain.handle('parse-search-engine', async (event, data) => {
    const { engine, query } = data;
    return new Promise((resolve) => {
        let isResolved = false;
        let parserWin = new BrowserWindow({
            width: 1100, height: 800, show: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true }
        });

        parserWin.on('closed', () => {
            if (!isResolved) {
                isResolved = true;
                resolve({ error: 'Окно закрыто пользователем до завершения' });
            }
        });

        const url = engine === 'google-ai'
            ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
            : `https://yandex.ru/search/?text=${encodeURIComponent(query)}`;

        parserWin.loadURL(url);

        // Внедряемые скрипты для поиска текста нейросетей (С ТВОИМИ НОВЫМИ КЛАССАМИ)
        const checkCode = engine === 'google-ai' ? `
            (function() {
                if (document.querySelector('form[action="/errors/t"]') || document.body.innerText.includes('systems have detected unusual traffic')) return 'CAPTCHA';
                
                // Ищем блок SGE / AI Overview
                const aiBlock = document.querySelector('.n6owBd.awi2gc') || 
                                document.querySelector('[data-attrid="SGE_SUMMARY"]') || 
                                document.querySelector('.M8OgIe') || 
                                document.querySelector('div[jscontroller="eL7ihd"]');
                
                if (aiBlock && aiBlock.innerText.length > 50) return aiBlock.innerText;
                return null;
            })()
        ` : `
            (function() {
                if (document.querySelector('.CheckboxCaptcha') || document.querySelector('.g-recaptcha')) return 'CAPTCHA';
                
                // Ищем блок Яндекс Нейро
                const aiBlock = document.querySelector('[data-fast-name="neuro_answer"]') ||
                                document.querySelector('.Neuro-Text') || 
                                document.querySelector('.neuro-result__content') || 
                                document.querySelector('.AliceSummary-Text');
                
                if (aiBlock && aiBlock.innerText.length > 50) return aiBlock.innerText;
                return null;
            })()
        `;

        let attempts = 0;
        const interval = setInterval(async () => {
            if (parserWin.isDestroyed()) {
                clearInterval(interval); return;
            }
            try {
                const result = await parserWin.webContents.executeJavaScript(checkCode);
                if (result === 'CAPTCHA') {
                    // Просто ждем, пока юзер введет капчу, попытки не тратим
                } else if (result) {
                    clearInterval(interval);
                    if (!isResolved) {
                        isResolved = true;
                        resolve({ text: result });
                        parserWin.destroy();
                    }
                } else {
                    attempts++;
                    if (attempts > 120) { // Ждем 2 минуты максимум
                        clearInterval(interval);
                        if (!isResolved) {
                            isResolved = true;
                            resolve({ error: 'Таймаут (Блок ИИ не появился)' });
                            parserWin.destroy();
                        }
                    }
                }
            } catch(e) {}
        }, 1000);
    });
});

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