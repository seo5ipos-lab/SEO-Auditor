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
            favorites: [] // Новое поле для избранных моделей
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

ipcMain.handle('parse-search-engine', async (event, data) => {
    const { engine, query } = data;
    return new Promise((resolve) => {
        let isResolved = false;
        let parserWin = new BrowserWindow({
            width: 1200, height: 800, show: true,
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

        // Инъекция кнопки ручного извлечения прямо в страницу поисковика
        const injectExtractionButton = `
            return new Promise((resolve) => {
                const btn = document.createElement('button');
                btn.innerText = '📥 ИЗВЛЕЧЬ ОТВЕТ НЕЙРОСЕТИ';
                btn.style.cssText = 'position:fixed; bottom:30px; right:30px; z-index:999999; padding:20px 30px; background:#2563eb; color:white; font-size:16px; font-weight:bold; border:none; border-radius:12px; cursor:pointer; box-shadow:0 10px 15px -3px rgba(0,0,0,0.3); transition: transform 0.2s;';
                btn.onmouseover = () => btn.style.transform = 'scale(1.05)';
                btn.onmouseout = () => btn.style.transform = 'scale(1)';
                
                document.body.appendChild(btn);

                btn.onclick = () => {
                    btn.innerText = 'Обработка...';
                    let text = '';
                    // Ищем по всем возможным селекторам Яндекса и Гугла
                    const aiBlock = document.querySelector('.n6owBd.awi2gc') || 
                                    document.querySelector('[data-attrid="SGE_SUMMARY"]') || 
                                    document.querySelector('.M8OgIe') || 
                                    document.querySelector('[data-fast-name="neuro_answer"]') ||
                                    document.querySelector('.Neuro-Text') || 
                                    document.querySelector('.neuro-result__content') || 
                                    document.querySelector('.AliceSummary-Text');
                    
                    if (aiBlock) text = aiBlock.innerText;
                    resolve(text || 'Текст не найден. Возможно, блок не успел сгенерироваться.');
                };
            });
        `;

        parserWin.webContents.on('did-finish-load', async () => {
            try {
                const result = await parserWin.webContents.executeJavaScript(injectExtractionButton);
                if (!isResolved) {
                    isResolved = true;
                    resolve({ text: result });
                    parserWin.destroy();
                }
            } catch(e) {}
        });
    });
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