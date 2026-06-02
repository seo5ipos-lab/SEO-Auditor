const { ipcRenderer } = require('electron');

// Настройка кастомного рендера для marked.js (Красивые тултипы ссылок)
const mdRenderer = new marked.Renderer();
mdRenderer.link = (href, title, text) => {
    return `<a href="${href}" target="_blank" class="source-link" data-url="${href}">
                <svg class="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                ${text}
                <span class="tooltip-text">${href}</span>
            </a>`;
};
marked.use({ renderer: mdRenderer });

let settings = {}, projects = [], activeProj = null, allModels = [];
let tempSelectedModels = new Set();
let modelsPricing = {};
let globalChartInst = null, modelsChartInst = null;

let taskQueue = [];
let isPaused = false;
let isCancelled = false;
let abortCtrl = null;
let currentSession = null;
let completedTasksCount = 0;

async function init() {
    settings = await ipcRenderer.invoke('get-settings');
    if (!settings.favorites) settings.favorites = []; // Инициализация избранного
    
    if (settings) {
        document.getElementById('set-or').value = settings.openRouterKey || '';
        document.getElementById('set-ya').value = settings.yandexToken || '';
        document.getElementById('set-prompt').value = settings.systemPrompt || '';
        if (settings.openRouterKey) fetchModelsAsync(settings.openRouterKey);
    }
    loadProjects();
}

document.getElementById('btn-save-settings').addEventListener('click', () => {
    settings.openRouterKey = document.getElementById('set-or').value.trim();
    settings.yandexToken = document.getElementById('set-ya').value.trim();
    settings.systemPrompt = document.getElementById('set-prompt').value.trim();
    ipcRenderer.send('save-settings', settings);
    if (settings.openRouterKey) fetchModelsAsync(settings.openRouterKey);
    alert('Настройки успешно сохранены!');
});

async function fetchModelsAsync(key) {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${key}` }});
        const data = await res.json();
        allModels = data.data || [];
        allModels.forEach(m => {
            modelsPricing[m.id] = { prompt: m.pricing?.prompt || 0, completion: m.pricing?.completion || 0 };
        });
        renderModelsList();
    } catch (e) { console.error("Ошибка загрузки моделей:", e); }
}

async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = '';
    projects.forEach(p => {
        grid.innerHTML += `
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 hover:shadow-md hover:border-blue-300 cursor-pointer relative group transition" onclick="openProject('${p.id}')">
                <div class="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mb-4 font-bold text-xl">${p.name ? p.name.charAt(0).toUpperCase() : 'P'}</div>
                <h3 class="font-bold text-lg text-slate-900 mb-1 truncate">${p.name || 'Без названия'}</h3>
                <p class="text-xs text-slate-500 mb-3 truncate">Бренд: ${p.brands || 'Не указан'}</p>
                <div class="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 px-3 py-1.5 rounded-md inline-flex">
                    <svg class="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
                    Сессий: ${p.sessions ? p.sessions.length : 0}
                </div>
                <button class="absolute top-4 right-4 text-red-500 opacity-0 group-hover:opacity-100 bg-red-50 hover:bg-red-100 p-2 rounded-lg transition" onclick="deleteProject('${p.id}', event)" title="Удалить проект">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>`;
    });
}

// Функции модального окна проекта
window.openProjectModal = () => {
    document.getElementById('modal-title').innerText = 'Создание проекта';
    document.getElementById('p-id').value = Date.now().toString();
    document.getElementById('p-name').value = '';
    document.getElementById('p-domains').value = '';
    document.getElementById('p-brands').value = '';
    document.getElementById('modal-project').classList.remove('hidden');
}

window.editCurrentProject = () => {
    if (!activeProj) return;
    document.getElementById('modal-title').innerText = 'Настройки проекта';
    document.getElementById('p-id').value = activeProj.id;
    document.getElementById('p-name').value = activeProj.name || '';
    document.getElementById('p-domains').value = activeProj.domains || '';
    document.getElementById('p-brands').value = activeProj.brands || '';
    document.getElementById('modal-project').classList.remove('hidden');
}

window.saveProjectFromModal = () => {
    const isEdit = activeProj && activeProj.id === document.getElementById('p-id').value;
    const proj = isEdit ? activeProj : { queries: [], models: [], sessions: [] };
    
    proj.id = document.getElementById('p-id').value;
    proj.name = document.getElementById('p-name').value;
    proj.domains = document.getElementById('p-domains').value;
    proj.brands = document.getElementById('p-brands').value;
    
    ipcRenderer.send('save-project', proj);
    document.getElementById('modal-project').classList.add('hidden');
    loadProjects();
    
    if (isEdit) {
        activeProj = proj;
        updateProjectDashboardUI();
    }
}

window.deleteProject = (id, e) => {
    e.stopPropagation();
    if(confirm('Точно удалить проект и всю его историю?')) { ipcRenderer.send('delete-project', id); loadProjects(); }
}

function updateProjectDashboardUI() {
    document.getElementById('dash-title').innerText = activeProj.name || 'Проект';
    document.getElementById('dash-info-domains').innerText = activeProj.domains || '-';
    document.getElementById('dash-info-brands').innerText = activeProj.brands || '-';
    document.getElementById('proj-queries').value = activeProj.queries.join('\n');
}

window.openProject = (id) => {
    activeProj = projects.find(p => p.id === id);
    if (!activeProj.sessions) activeProj.sessions = [];
    if (!activeProj.queries) activeProj.queries = [];
    if (!activeProj.models) activeProj.models = [];
    
    updateProjectDashboardUI();
    
    document.getElementById('cb-google-ai').checked = activeProj.models.includes('google-ai');
    document.getElementById('cb-yandex-alisa').checked = activeProj.models.includes('yandex-alisa');
    
    tempSelectedModels = new Set(activeProj.models.filter(m => m !== 'google-ai' && m !== 'yandex-alisa'));
    document.getElementById('search-models').value = '';
    renderModelsList();
    
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-project-dashboard').classList.add('active');
    switchProjTab('ptab-setup');
}

window.toggleFavorite = (modelId, e) => {
    e.stopPropagation();
    if (settings.favorites.includes(modelId)) {
        settings.favorites = settings.favorites.filter(id => id !== modelId);
    } else {
        settings.favorites.push(modelId);
    }
    ipcRenderer.send('save-settings', settings);
    renderModelsList();
}

// Оптимизированный рендер с виртуализацией (Slice) и Избранным
document.getElementById('search-models').addEventListener('input', () => renderModelsList());

function renderModelsList() {
    const list = document.getElementById('proj-models-list');
    const search = document.getElementById('search-models').value.toLowerCase();
    list.innerHTML = '';
    if (allModels.length === 0) return list.innerHTML = '<p class="text-red-500 text-sm">Модели не загружены.</p>';
    
    // Фильтрация и Сортировка (Избранные сверху)
    let filtered = allModels.filter(m => {
        const mId = m.id ? m.id.toLowerCase() : '';
        const mName = m.name ? m.name.toLowerCase() : '';
        return mId.includes(search) || mName.includes(search);
    });

    filtered.sort((a, b) => {
        const aFav = settings.favorites.includes(a.id);
        const bFav = settings.favorites.includes(b.id);
        if (aFav && !bFav) return -1;
        if (!aFav && bFav) return 1;
        return 0;
    });

    // Рендерим только первые 50 для производительности, если нет строгого поиска
    const limit = search ? filtered.length : 50;
    
    filtered.slice(0, limit).forEach(m => {
        const checked = tempSelectedModels.has(m.id) ? 'checked' : '';
        const isFav = settings.favorites.includes(m.id);
        const starCol = isFav ? 'text-yellow-400 fill-current' : 'text-slate-300 hover:text-yellow-400';
        
        const label = document.createElement('label');
        label.className = 'flex items-center p-2 hover:bg-slate-100 rounded-lg cursor-pointer transition border border-transparent hover:border-slate-200';
        label.innerHTML = `
            <input type="checkbox" value="${m.id}" class="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 mr-3" ${checked}>
            <div class="flex-grow min-w-0">
                <div class="font-semibold text-slate-800 text-sm truncate">${m.id}</div>
                <div class="text-xs text-slate-400 truncate">${m.name || 'Без названия'}</div>
            </div>
            <button class="ml-2 p-1 focus:outline-none" onclick="toggleFavorite('${m.id}', event)" title="В избранное">
                <svg class="w-5 h-5 ${starCol} transition-colors" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
            </button>
        `;
        
        label.querySelector('input').addEventListener('change', (e) => {
            if (e.target.checked) tempSelectedModels.add(m.id);
            else tempSelectedModels.delete(m.id);
        });
        list.appendChild(label);
    });
    
    if (filtered.length > 50 && !search) {
        list.innerHTML += `<p class="text-xs text-center text-slate-400 mt-2 py-2">Показаны первые 50. Используйте поиск.</p>`;
    }
}

window.saveProjectData = () => {
    activeProj.queries = document.getElementById('proj-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    
    const nativeModels = [];
    if (document.getElementById('cb-google-ai').checked) nativeModels.push('google-ai');
    if (document.getElementById('cb-yandex-alisa').checked) nativeModels.push('yandex-alisa');
    
    activeProj.models = [...Array.from(tempSelectedModels), ...nativeModels];
    ipcRenderer.send('save-project', activeProj);
    
    const btn = document.querySelector('button[onclick="saveProjectData()"]');
    const oldText = btn.innerText;
    btn.innerText = '✓ Сохранено';
    btn.classList.replace('bg-blue-600', 'bg-emerald-600');
    setTimeout(() => {
        btn.innerText = oldText;
        btn.classList.replace('bg-emerald-600', 'bg-blue-600');
    }, 2000);
}

function extractDomains(text) {
    const regex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g;
    const matches = []; let match;
    while ((match = regex.exec(text)) !== null) { matches.push(match[1].toLowerCase()); }
    return [...new Set(matches)];
}

async function fetchWordstatRealAPI(query, token) {
    if (!token) return { freq: 0, status: '<span class="text-slate-400 text-xs">Пропуск WS</span>' };
    try {
        const url = 'https://api.direct.yandex.ru/v4/json/';
        const reqOpts = (method, param) => ({ method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ method: method, param: param, token: token }) });

        const createRes = await fetch(url, reqOpts('CreateNewWordstatReport', { Phrases: [query], GeoID: [225] }));
        const createData = await createRes.json();
        if (createData.error_code) return { freq: 0, status: `<span class="text-red-500 font-bold text-xs" title="${createData.error_str}">Код: ${createData.error_code}</span>` };
        
        const reportId = createData.data;
        let isDone = false; let attempts = 0;
        while (!isDone && attempts < 15) {
            await new Promise(r => setTimeout(r, 2000));
            const listRes = await fetch(url, reqOpts('GetWordstatReportList', null));
            const listData = await listRes.json();
            if (listData.data) {
                const report = listData.data.find(r => r.ReportID === reportId);
                if (report && report.StatusReport === 'Done') isDone = true;
            }
            attempts++;
        }

        if (isDone) {
            const getRes = await fetch(url, reqOpts('GetWordstatReport', reportId));
            const getData = await getRes.json();
            const freq = getData.data[0]?.SearchedWith[0]?.Shows || 0;
            await fetch(url, reqOpts('DeleteWordstatReport', reportId));
            return { freq: freq, status: `<span class="text-emerald-600 font-bold">${freq}</span>` };
        } else {
            return { freq: 0, status: '<span class="text-amber-500 text-xs">Таймаут</span>' };
        }
    } catch (e) {
        return { freq: 0, status: `<span class="text-red-500 text-xs" title="${e.message}">Сбой сети</span>` };
    }
}

// --- УПРАВЛЕНИЕ ОЧЕРЕДЬЮ И СЪЕМ ---
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnContinue = document.getElementById('btn-continue');
const btnCancel = document.getElementById('btn-cancel');

function resetQueueUI() {
    btnStart.classList.remove('hidden');
    btnStop.classList.add('hidden');
    btnContinue.classList.add('hidden');
    btnCancel.classList.add('hidden');
    document.getElementById('status-progress').innerHTML = 'Остановлено/Отменено';
}

btnStart.addEventListener('click', async () => {
    window.saveProjectData();
    if (activeProj.queries.length === 0 || activeProj.models.length === 0) return alert('Добавьте запросы и выберите модели!');
    if (!settings.openRouterKey) return alert('Нет API ключа OpenRouter!');

    document.getElementById('results-tbody').innerHTML = ''; 
    currentSession = {
        date: new Date().toLocaleString(), totalTasks: activeProj.queries.length * activeProj.models.length,
        successQueries: 0, weightTotal: 0, weightedSum: 0, domainsFound: {}, queriesResult: {}, totalCost: 0
    };
    
    taskQueue = []; completedTasksCount = 0; isCancelled = false;
    for (const q of activeProj.queries) {
        currentSession.queriesResult[q] = { freq: 0, modelsData: {} };
        for (const m of activeProj.models) taskQueue.push({ query: q, model: m });
    }
    startQueue({});
});

btnStop.addEventListener('click', () => {
    isPaused = true;
    if (abortCtrl) abortCtrl.abort();
    btnStop.classList.add('hidden'); btnContinue.classList.remove('hidden');
    document.getElementById('status-progress').innerHTML += ' <span class="text-amber-500 font-bold">(Пауза)</span>';
});

btnContinue.addEventListener('click', () => startQueue(currentSession.wordstatCache || {}));
btnCancel.addEventListener('click', () => {
    if(confirm('Отменить задачу? Данные не будут сохранены.')) {
        isCancelled = true; taskQueue = []; if (abortCtrl) abortCtrl.abort(); resetQueueUI();
    }
});

function startQueue(wsCache) {
    isPaused = false; isCancelled = false; currentSession.wordstatCache = wsCache;
    btnStart.classList.add('hidden'); btnContinue.classList.add('hidden');
    btnStop.classList.remove('hidden'); btnCancel.classList.remove('hidden');
    processQueue();
}

async function processQueue() {
    const tbody = document.getElementById('results-tbody');
    const brandKeywords = (activeProj.brands || '').split(',').map(b=>b.trim().toLowerCase()).filter(Boolean);
    const myDomains = (activeProj.domains || '').split(',').map(d=>d.trim().toLowerCase()).filter(Boolean);

    while (taskQueue.length > 0 && !isPaused && !isCancelled) {
        const task = taskQueue.shift(); 
        abortCtrl = new AbortController();
        const tid = `tr-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        
        let visualModelName = task.model;
        let modelBg = 'bg-blue-50 text-blue-700 border-blue-200';
        if (task.model === 'google-ai') { visualModelName = 'Google AI'; modelBg = 'bg-emerald-50 text-emerald-700 border-emerald-200'; }
        if (task.model === 'yandex-alisa') { visualModelName = 'Yandex Нейро'; modelBg = 'bg-red-50 text-red-700 border-red-200'; }

        const trMain = document.createElement('tr');
        trMain.className = "hover:bg-slate-50 border-b border-slate-100 cursor-pointer transition";
        trMain.onclick = () => toggleAccordion(`det-${tid}`);
        trMain.innerHTML = `
            <td class="p-4 border-r border-slate-100">
                <div class="font-bold text-slate-800 text-[13px] leading-tight mb-1">${task.query}</div>
                <div class="text-[10px] uppercase tracking-wider font-bold ${modelBg} border inline-block px-2 py-0.5 rounded">${visualModelName}</div>
            </td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-ws"><span class="animate-pulse text-slate-300">WS...</span></td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-status"><span class="animate-pulse text-blue-500 font-semibold">Генерация...</span></td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-sent"><span class="text-slate-300">-</span></td>
            <td class="p-4 text-xs" id="${tid}-src"><span class="text-slate-300">-</span></td>
        `;

        const trDet = document.createElement('tr');
        trDet.id = `det-${tid}`;
        trDet.className = "hidden bg-slate-50/50 shadow-inner";
        trDet.innerHTML = `<td colspan="5"><div class="p-6 text-sm text-slate-700 markdown-body" id="${tid}-content">Ожидание данных...</div></td>`;

        tbody.prepend(trDet); tbody.prepend(trMain);

        let fullText = '';
        try {
            if (currentSession.wordstatCache[task.query] === undefined) {
                const wsResult = await fetchWordstatRealAPI(task.query, settings.yandexToken);
                currentSession.wordstatCache[task.query] = wsResult;
                currentSession.queriesResult[task.query].freq = wsResult.freq;
            }
            const wsFreqData = currentSession.wordstatCache[task.query];
            document.getElementById(`${tid}-ws`).innerHTML = wsFreqData.status;

            // РУЧНОЙ ЛЕНИВЫЙ ПАРСИНГ ДЛЯ GOOGLE И YANDEX
            if (task.model === 'google-ai' || task.model === 'yandex-alisa') {
                document.getElementById(`${tid}-status`).innerHTML = `<button id="btn-parse-${tid}" class="bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold py-1.5 px-3 rounded shadow-sm transition">▶ Открыть браузер</button>`;
                
                await new Promise((resolve, reject) => {
                    const btn = document.getElementById(`btn-parse-${tid}`);
                    btn.addEventListener('click', async (e) => {
                        e.stopPropagation(); // Отменяем раскрытие аккордеона по клику на кнопку
                        btn.outerHTML = `<span class="animate-pulse text-indigo-600 font-bold">Ожидание извлечения...</span>`;
                        try {
                            const parseRes = await ipcRenderer.invoke('parse-search-engine', { engine: task.model, query: task.query });
                            if (parseRes.error) throw new Error(parseRes.error);
                            fullText = parseRes.text || '';
                            document.getElementById(`${tid}-content`).innerHTML = marked.parse(fullText);
                            resolve();
                        } catch(err) { reject(err); }
                    });
                });
            } else {
                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: task.model, messages: [{role: 'user', content: task.query}], stream: true }), signal: abortCtrl.signal
                });
                if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

                const reader = res.body.getReader(); const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read(); if (done) break;
                    const lines = decoder.decode(value, { stream: true }).split('\n').filter(l => l.trim() !== '');
                    for (const line of lines) {
                        if (line.replace(/^data: /, '') === '[DONE]') break;
                        if (line.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(line.replace(/^data: /, ''));
                                if (parsed.choices && parsed.choices[0].delta && parsed.choices[0].delta.content) {
                                    fullText += parsed.choices[0].delta.content;
                                    document.getElementById(`${tid}-content`).innerHTML = marked.parse(fullText);
                                }
                            } catch(e){}
                        }
                    }
                }
                const pricing = modelsPricing[task.model] || { prompt: 0, completion: 0 };
                currentSession.totalCost += ((task.query.length / 4) * parseFloat(pricing.prompt || 0)) + ((fullText.length / 4) * parseFloat(pricing.completion || 0));
                document.getElementById('status-cost').innerText = `$${currentSession.totalCost.toFixed(6)}`;
            }

            const foundDomains = extractDomains(fullText);
            document.getElementById(`${tid}-src`).innerHTML = foundDomains.length > 0 ? foundDomains.map(d => `<span class="inline-block bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] m-0.5">${d}</span>`).join('') : '<span class="text-slate-300">Нет</span>';
            foundDomains.forEach(d => { if(!myDomains.includes(d)) currentSession.domainsFound[d] = (currentSession.domainsFound[d] || 0) + 1; });

            const isBrandFound = brandKeywords.some(b => fullText.toLowerCase().includes(b)) || foundDomains.some(d => myDomains.includes(d));
            currentSession.queriesResult[task.query].modelsData[task.model] = isBrandFound ? 1 : 0;
            
            if (wsFreqData.freq > 0) {
                currentSession.weightTotal += wsFreqData.freq;
                if(isBrandFound) currentSession.weightedSum += wsFreqData.freq;
            }

            if (isBrandFound) {
                currentSession.successQueries++;
                trMain.classList.replace('hover:bg-slate-50', 'bg-emerald-50/30');
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-emerald-600 font-bold flex items-center justify-center gap-1"><svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg> Найдено</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = '<span class="text-blue-500 animate-pulse text-[10px] uppercase font-bold">Анализ ИИ...</span>';
                
                try {
                    const sentRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST', headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [{role: 'user', content: `Определи тональность упоминания "${activeProj.brands}" в тексте: "${fullText}". Ответь 1 словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.`}]})
                    });
                    const sentData = await sentRes.json();
                    const sentiment = sentData.choices[0].message.content.trim().toUpperCase();
                    let col = sentiment.includes('ПОЗИТИВ') ? 'text-emerald-600 bg-emerald-100' : sentiment.includes('НЕГАТИВ') ? 'text-red-600 bg-red-100' : 'text-slate-600 bg-slate-200';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold px-2 py-1 rounded text-[10px] tracking-wide inline-block">${sentiment}</span>`;
                } catch(e) { document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-amber-500 text-[10px]">Ошибка ИИ</span>`; }
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-slate-400 font-bold text-xs">Не найдено</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-slate-300">-</span>`;
            }
            completedTasksCount++;
            document.getElementById('status-progress').innerText = `${completedTasksCount}/${currentSession.totalTasks}`;

        } catch (error) {
            if (error.name === 'AbortError') { taskQueue.unshift(task); trMain.remove(); trDet.remove(); break; } 
            else { document.getElementById(`${tid}-status`).innerHTML = `<span class="text-red-500 font-bold text-xs">Ошибка: ${error.message.substring(0,15)}</span>`; completedTasksCount++; }
        }
    }

    if (!isPaused && !isCancelled && taskQueue.length === 0) {
        currentSession.vGen = currentSession.totalTasks > 0 ? ((currentSession.successQueries / currentSession.totalTasks) * 100).toFixed(1) : 0;
        currentSession.vWeight = currentSession.weightTotal > 0 ? ((currentSession.weightedSum / currentSession.weightTotal) * 100).toFixed(1) : 0;
        activeProj.sessions.push(currentSession); ipcRenderer.send('save-project', activeProj);
        document.getElementById('status-progress').innerHTML += ' <span class="text-emerald-600 font-bold">(Завершено)</span>';
        resetQueueUI(); btnStart.classList.remove('hidden'); btnStart.innerText = 'Начать новый сбор';
    }
}

// --- ИСТОРИЯ И АНАЛИТИКА ---
window.deleteSession = (index) => {
    if(confirm('Удалить эту сессию съема?')) {
        activeProj.sessions.splice(index, 1); ipcRenderer.send('save-project', activeProj); renderHistory();
    }
}

window.renderHistory = () => {
    if (!activeProj || !activeProj.sessions) return;
    let allQueries = new Set(activeProj.queries || []);
    activeProj.sessions.forEach(s => { if(s.queriesResult) Object.keys(s.queriesResult).forEach(q => allQueries.add(q)); });
    
    const thead = document.getElementById('history-thead'); const tbody = document.getElementById('history-tbody');
    let ths = '<tr><th class="p-3 border-r border-slate-200 uppercase text-xs tracking-wide">Запрос</th><th class="p-3 border-r border-slate-200 text-center uppercase text-xs">WS</th>';
    activeProj.sessions.forEach((s, idx) => {
        ths += `<th class="p-3 text-center border-r border-slate-200 min-w-[130px]">
            <div class="text-[10px] text-slate-400 mb-1 font-normal">${s.date}</div>
            <div class="text-blue-600 font-bold text-sm bg-blue-50 py-1 rounded">V: ${s.vGen}%</div>
            <button onclick="deleteSession(${idx})" class="text-[10px] text-red-400 hover:text-red-600 transition mt-1 uppercase font-bold tracking-wide">Удалить</button>
        </th>`;
    });
    thead.innerHTML = ths + '</tr>';
    
    tbody.innerHTML = '';
    Array.from(allQueries).forEach(q => {
        let latestFreq = 'WS';
        for(let i = activeProj.sessions.length - 1; i >= 0; i--) {
            if(activeProj.sessions[i].queriesResult[q] && activeProj.sessions[i].queriesResult[q].freq) { latestFreq = activeProj.sessions[i].queriesResult[q].freq; break; }
        }
        let row = `<tr><td class="p-3 border-r border-slate-100 text-sm font-semibold text-slate-800">${q}</td><td class="p-3 border-r border-slate-100 text-xs font-bold text-emerald-600 text-center bg-emerald-50/30">${latestFreq}</td>`;
        activeProj.sessions.forEach(s => {
            if(s.queriesResult && s.queriesResult[q]) {
                const totalM = Object.keys(s.queriesResult[q].modelsData || {}).length;
                const found = Object.values(s.queriesResult[q].modelsData).reduce((a,b)=>a+b, 0);
                const perc = totalM > 0 ? ((found/totalM)*100).toFixed(0) : 0;
                row += `<td class="p-3 border-r border-slate-100 text-center ${perc > 0 ? 'text-emerald-600 font-bold bg-emerald-50/10' : 'text-slate-300'}">${perc}%</td>`;
            } else { row += `<td class="p-3 border-r border-slate-100 text-center text-slate-200">-</td>`; }
        });
        tbody.innerHTML += row + `</tr>`;
    });

    let allCompetitors = {};
    activeProj.sessions.forEach(s => { if (s.domainsFound) Object.entries(s.domainsFound).forEach(([dom, count]) => { allCompetitors[dom] = (allCompetitors[dom] || 0) + count; }); });
    const cList = document.getElementById('competitors-list'); cList.innerHTML = '';
    Object.entries(allCompetitors).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([dom, count]) => {
        cList.innerHTML += `<li class="flex justify-between items-center border-b border-slate-100 py-2"><span class="text-slate-700 font-medium">${dom}</span><span class="font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded text-xs">${count}</span></li>`;
    });
    drawCharts();
}

function drawCharts() {
    if (!activeProj || !activeProj.sessions || activeProj.sessions.length === 0) return;
    const labels = activeProj.sessions.map(s => s.date.split(',')[0]);
    Chart.defaults.font.family = 'Inter'; Chart.defaults.color = '#64748b';
    
    if (globalChartInst) globalChartInst.destroy();
    const ctxG = document.getElementById('chart-global');
    if (ctxG) {
        globalChartInst = new Chart(ctxG.getContext('2d'), {
            type: 'line', data: { labels: labels, datasets: [
                { label: 'Общая (%)', data: activeProj.sessions.map(s => parseFloat(s.vGen || 0)), borderColor: '#2563eb', backgroundColor: '#2563eb20', tension: 0.4, fill: true },
                { label: 'Взвешенная (%)', data: activeProj.sessions.map(s => parseFloat(s.vWeight || 0)), borderColor: '#10b981', tension: 0.4 }
            ]}, options: { responsive: true, plugins: { legend: { position: 'top' } }, scales: { y: { min: 0, max: 100 } } }
        });
    }

    let dModels = [], sessionModels = new Set();
    activeProj.sessions.forEach(s => { if(s.queriesResult) Object.values(s.queriesResult).forEach(qr => { if(qr.modelsData) Object.keys(qr.modelsData).forEach(m => sessionModels.add(m)); }); });
    let colors = ['#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899']; let mIdx = 0;
    
    sessionModels.forEach(model => {
        dModels.push({ label: model === 'google-ai' ? 'Google AI' : model === 'yandex-alisa' ? 'Yandex Нейро' : model, data: activeProj.sessions.map(s => {
            let total = 0, found = 0;
            if(s.queriesResult) Object.values(s.queriesResult).forEach(qr => { if (qr.modelsData && qr.modelsData[model] !== undefined) { total++; found += qr.modelsData[model]; } });
            return total > 0 ? (found/total)*100 : null;
        }), borderColor: colors[mIdx % colors.length], tension: 0.4, spanGaps: true, pointRadius: 4 }); mIdx++;
    });

    if (modelsChartInst) modelsChartInst.destroy();
    const ctxM = document.getElementById('chart-models');
    if (ctxM) modelsChartInst = new Chart(ctxM.getContext('2d'), { type: 'line', data: { labels: labels, datasets: dModels }, options: { responsive: true, scales: { y: { min: 0, max: 100 } } } });
}

window.runFinalAnalysis = async () => {
    if (!activeProj.sessions || !activeProj.sessions.length) return alert('Сначала проведите съемы данных!');
    if (!settings.openRouterKey) return alert('Нет API ключа!');
    
    const box = document.getElementById('final-analysis-box'); box.classList.remove('hidden');
    box.innerHTML = '<span class="text-indigo-600 animate-pulse font-bold flex items-center gap-2"><svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> Gemma анализирует графики...</span>';

    let dynText = activeProj.sessions.map((s, i) => `Сессия ${i+1} (${s.date}): Общая ${s.vGen}%, Взвешенная ${s.vWeight}%.`).join(' ');
    const lastS = activeProj.sessions[activeProj.sessions.length - 1];
    const dataPrompt = `История съемов: ${dynText}. Главные конкуренты последней сессии: ${lastS.domainsFound ? Object.keys(lastS.domainsFound).slice(0,10).join(', ') : 'Нет'}. Сделай выводы о динамике.`;

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [ { role: 'system', content: settings.systemPrompt }, { role: 'user', content: dataPrompt } ] }) });
        const data = await res.json(); box.innerHTML = marked.parse(data.choices[0].message.content);
    } catch (e) { box.innerHTML = '<span class="text-red-500 font-bold">Ошибка API. Проверьте соединение.</span>'; }
}

init();