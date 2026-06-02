const { ipcRenderer } = require('electron');

// --- ОБНОВЛЕННЫЙ РЕНДЕР ССЫЛОК (Защита от обновлений API marked.js) ---
const mdRenderer = new marked.Renderer();
mdRenderer.link = function(token) {
    // Проверяем, какой формат данных нам прислала библиотека (строка или объект)
    const href = typeof token === 'string' ? arguments[0] : token.href;
    const text = typeof token === 'string' ? arguments[2] : (token.text || 'Ссылка');
    
    return `<a href="${href}" target="_blank" class="source-link" data-url="${href}"><svg class="w-3 h-3 inline" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg> ${text} <span class="tooltip-text">${href}</span></a>`;
};
marked.use({ renderer: mdRenderer });
// ----------------------------------------------------------------------

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
    if (!settings.favorites) settings.favorites = []; 
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
    alert('Настройки сохранены!');
});

async function fetchModelsAsync(key) {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${key}` }});
        const data = await res.json();
        allModels = data.data || [];
        allModels.forEach(m => modelsPricing[m.id] = { prompt: m.pricing?.prompt || 0, completion: m.pricing?.completion || 0 });
        renderModelsList();
    } catch (e) {}
}

async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = '';
    projects.forEach(p => {
        grid.innerHTML += `
            <div class="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 hover:shadow-md cursor-pointer relative group transition" onclick="openProject('${p.id}')">
                <div class="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mb-4 font-bold text-xl">${p.name ? p.name.charAt(0).toUpperCase() : 'P'}</div>
                <h3 class="font-bold text-lg text-slate-900 mb-1 truncate">${p.name || 'Без названия'}</h3>
                <p class="text-xs text-slate-500 mb-3 truncate">Бренд: ${p.brands || 'Не указан'}</p>
                <div class="flex items-center gap-2 text-xs font-semibold text-slate-600 bg-slate-50 px-3 py-1.5 rounded-md inline-flex">Сессий: ${p.sessions ? p.sessions.length : 0}</div>
                <button class="absolute top-4 right-4 text-red-500 opacity-0 group-hover:opacity-100 bg-red-50 hover:bg-red-100 p-2 rounded-lg" onclick="deleteProject('${p.id}', event)">Удалить</button>
            </div>`;
    });
}

window.openProjectModal = () => {
    document.getElementById('modal-title').innerText = 'Создание проекта';
    document.getElementById('p-id').value = Date.now().toString();
    document.getElementById('p-name').value = ''; document.getElementById('p-domains').value = ''; document.getElementById('p-brands').value = '';
    document.getElementById('modal-project').classList.remove('hidden');
}

window.editCurrentProject = () => {
    if (!activeProj) return;
    document.getElementById('modal-title').innerText = 'Настройки проекта';
    document.getElementById('p-id').value = activeProj.id;
    document.getElementById('p-name').value = activeProj.name || ''; document.getElementById('p-domains').value = activeProj.domains || ''; document.getElementById('p-brands').value = activeProj.brands || '';
    document.getElementById('modal-project').classList.remove('hidden');
}

window.saveProjectFromModal = () => {
    const isEdit = activeProj && activeProj.id === document.getElementById('p-id').value;
    const proj = isEdit ? activeProj : { queries: [], models: [], sessions: [] };
    proj.id = document.getElementById('p-id').value; proj.name = document.getElementById('p-name').value; proj.domains = document.getElementById('p-domains').value; proj.brands = document.getElementById('p-brands').value;
    ipcRenderer.send('save-project', proj);
    document.getElementById('modal-project').classList.add('hidden');
    loadProjects();
    if (isEdit) { activeProj = proj; updateProjectDashboardUI(); }
}

window.deleteProject = (id, e) => { e.stopPropagation(); if(confirm('Удалить проект?')) { ipcRenderer.send('delete-project', id); loadProjects(); } }

function updateProjectDashboardUI() {
    document.getElementById('dash-title').innerText = activeProj.name || 'Проект';
    document.getElementById('dash-info-domains').innerText = activeProj.domains || '-';
    document.getElementById('dash-info-brands').innerText = activeProj.brands || '-';
    document.getElementById('proj-queries').value = activeProj.queries.join('\n');
}

window.openProject = (id) => {
    document.getElementById('results-tbody').innerHTML = '<tr><td colspan="5" class="p-8 text-center text-slate-400">Очередь пуста</td></tr>';
    taskQueue = []; currentSession = null; completedTasksCount = 0; resetQueueUI();
    document.getElementById('history-snapshot-view').classList.add('hidden');
    document.getElementById('history-main-view').classList.remove('hidden');

    activeProj = projects.find(p => p.id === id);
    if (!activeProj.sessions) activeProj.sessions = [];
    if (!activeProj.queries) activeProj.queries = [];
    if (!activeProj.models) activeProj.models = [];
    
    updateProjectDashboardUI();
    
    document.getElementById('cb-google-ai').checked = activeProj.models.includes('google-ai');
    document.getElementById('cb-yandex-alisa').checked = activeProj.models.includes('yandex-alisa');
    
    document.getElementById('cb-web-search').checked = !!activeProj.useWebSearch;
    document.getElementById('num-concurrency').value = activeProj.concurrency || 1;

    tempSelectedModels = new Set(activeProj.models.filter(m => m !== 'google-ai' && m !== 'yandex-alisa'));
    document.getElementById('search-models').value = '';
    renderModelsList();
    
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-project-dashboard').classList.add('active');
    switchProjTab('ptab-setup');
}

window.toggleFavorite = (modelId, e) => {
    e.stopPropagation();
    if (settings.favorites.includes(modelId)) settings.favorites = settings.favorites.filter(id => id !== modelId);
    else settings.favorites.push(modelId);
    ipcRenderer.send('save-settings', settings); renderModelsList();
}

document.getElementById('search-models').addEventListener('input', () => renderModelsList());

function renderModelsList() {
    const list = document.getElementById('proj-models-list');
    const search = document.getElementById('search-models').value.toLowerCase();
    list.innerHTML = '';
    if (allModels.length === 0) return list.innerHTML = '<p class="text-slate-400 text-sm">Модели не загружены.</p>';
    
    let filtered = allModels.filter(m => (m.id && m.id.toLowerCase().includes(search)) || (m.name && m.name.toLowerCase().includes(search)));
    filtered.sort((a, b) => {
        const aFav = settings.favorites.includes(a.id), bFav = settings.favorites.includes(b.id);
        return (aFav && !bFav) ? -1 : (!aFav && bFav) ? 1 : 0;
    });

    const limit = search ? filtered.length : 50;
    filtered.slice(0, limit).forEach(m => {
        const checked = tempSelectedModels.has(m.id) ? 'checked' : '';
        const starCol = settings.favorites.includes(m.id) ? 'text-yellow-400 fill-current' : 'text-slate-300';
        const label = document.createElement('label');
        label.className = 'flex items-center p-2 hover:bg-slate-100 rounded-lg cursor-pointer border border-transparent';
        label.innerHTML = `<input type="checkbox" value="${m.id}" class="w-4 h-4 text-blue-600 rounded mr-3" ${checked}>
            <div class="flex-grow min-w-0"><div class="font-semibold text-slate-800 text-sm truncate">${m.id}</div></div>
            <button class="ml-2 p-1" onclick="toggleFavorite('${m.id}', event)"><svg class="w-5 h-5 ${starCol}" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg></button>`;
        label.querySelector('input').addEventListener('change', (e) => { e.target.checked ? tempSelectedModels.add(m.id) : tempSelectedModels.delete(m.id); });
        list.appendChild(label);
    });
}

window.saveProjectData = () => {
    activeProj.queries = document.getElementById('proj-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    const nativeModels = [];
    if (document.getElementById('cb-google-ai').checked) nativeModels.push('google-ai');
    if (document.getElementById('cb-yandex-alisa').checked) nativeModels.push('yandex-alisa');
    
    activeProj.useWebSearch = document.getElementById('cb-web-search').checked;
    activeProj.concurrency = parseInt(document.getElementById('num-concurrency').value) || 1;

    activeProj.models = [...Array.from(tempSelectedModels), ...nativeModels];
    ipcRenderer.send('save-project', activeProj);
    const btn = document.querySelector('button[onclick="saveProjectData()"]'); const oldText = btn.innerText;
    btn.innerText = '✓ Сохранено'; btn.classList.replace('bg-blue-600', 'bg-emerald-600');
    setTimeout(() => { btn.innerText = oldText; btn.classList.replace('bg-emerald-600', 'bg-blue-600'); }, 2000);
}

function extractDomains(text) {
    const regex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g;
    const matches = []; let match;
    while ((match = regex.exec(text)) !== null) { matches.push(match[1].toLowerCase()); }
    return [...new Set(matches)];
}

async function fetchWordstatRealAPI(query, token) {
    if (!token) return { freq: 0, status: '<span class="text-slate-400 text-[10px] uppercase font-bold">Пропуск</span>' };
    try {
        const url = 'https://api.direct.yandex.ru/v4/json/';
        const reqOpts = (method, param) => ({ method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ method: method, param: param, token: token }) });
        const createRes = await fetch(url, reqOpts('CreateNewWordstatReport', { Phrases: [query], GeoID: [225] }));
        const createData = await createRes.json();
        if (createData.error_code) return { freq: 0, status: `<span class="text-red-500 font-bold text-xs" title="${createData.error_str}">Код: ${createData.error_code}</span>` };
        
        const reportId = createData.data; let isDone = false; let attempts = 0;
        while (!isDone && attempts < 15) {
            await new Promise(r => setTimeout(r, 2000));
            const listData = await (await fetch(url, reqOpts('GetWordstatReportList', null))).json();
            if (listData.data) { const report = listData.data.find(r => r.ReportID === reportId); if (report && report.StatusReport === 'Done') isDone = true; }
            attempts++;
        }
        if (isDone) {
            const getData = await (await fetch(url, reqOpts('GetWordstatReport', reportId))).json();
            const freq = getData.data[0]?.SearchedWith[0]?.Shows || 0;
            await fetch(url, reqOpts('DeleteWordstatReport', reportId));
            return { freq: freq, status: `<span class="text-emerald-600 font-bold">${freq}</span>` };
        } else return { freq: 0, status: '<span class="text-amber-500 text-xs">Таймаут</span>' };
    } catch (e) { return { freq: 0, status: `<span class="text-red-500 text-xs">Сбой сети</span>` }; }
}

const btnStart = document.getElementById('btn-start'), btnStop = document.getElementById('btn-stop'), btnContinue = document.getElementById('btn-continue'), btnCancel = document.getElementById('btn-cancel');

function resetQueueUI() {
    btnStart.classList.remove('hidden'); btnStop.classList.add('hidden'); btnContinue.classList.add('hidden'); btnCancel.classList.add('hidden');
    document.getElementById('status-progress').innerHTML = 'Остановлено/Отменено';
}

btnStart.addEventListener('click', async () => {
    window.saveProjectData();
    if (activeProj.queries.length === 0 || activeProj.models.length === 0) return alert('Добавьте запросы и выберите модели!');
    document.getElementById('results-tbody').innerHTML = ''; 
    currentSession = { date: new Date().toLocaleString(), totalTasks: activeProj.queries.length * activeProj.models.length, successQueries: 0, weightTotal: 0, weightedSum: 0, domainsFound: {}, queriesResult: {}, totalCost: 0 };
    taskQueue = []; completedTasksCount = 0; isCancelled = false;
    for (const q of activeProj.queries) {
        currentSession.queriesResult[q] = { freq: 0, modelsData: {} };
        for (const m of activeProj.models) taskQueue.push({ query: q, model: m });
    }
    startQueue({});
});

btnStop.addEventListener('click', () => {
    isPaused = true; if (abortCtrl) abortCtrl.abort();
    btnStop.classList.add('hidden'); btnContinue.classList.remove('hidden');
    document.getElementById('status-progress').innerHTML += ' <span class="text-amber-500 font-bold">(Пауза)</span>';
});

btnContinue.addEventListener('click', () => startQueue(currentSession.wordstatCache || {}));
btnCancel.addEventListener('click', () => {
    if(confirm('Отменить задачу? Данные будут стерты.')) { isCancelled = true; taskQueue = []; if (abortCtrl) abortCtrl.abort(); resetQueueUI(); }
});

function startQueue(wsCache) {
    isPaused = false; isCancelled = false; currentSession.wordstatCache = wsCache;
    btnStart.classList.add('hidden'); btnContinue.classList.add('hidden'); btnStop.classList.remove('hidden'); btnCancel.classList.remove('hidden');
    processQueue();
}

async function processQueue() {
    const tbody = document.getElementById('results-tbody');
    const brandKeywords = (activeProj.brands || '').split(',').map(b=>b.trim().toLowerCase()).filter(Boolean);
    const myDomains = (activeProj.domains || '').split(',').map(d=>d.trim().toLowerCase()).filter(Boolean);
    
    abortCtrl = new AbortController();

    const processTask = async (task) => {
        const tid = `tr-${Date.now()}-${Math.floor(Math.random()*10000)}`;
        
        let visualModelName = task.model;
        let modelBg = 'bg-blue-50 text-blue-700 border-blue-200';
        if (task.model === 'google-ai') { visualModelName = 'Google AI'; modelBg = 'bg-emerald-50 text-emerald-700 border-emerald-200'; }
        if (task.model === 'yandex-alisa') { visualModelName = 'Yandex Нейро'; modelBg = 'bg-red-50 text-red-700 border-red-200'; }

        const trMain = document.createElement('tr');
        trMain.className = "hover:bg-slate-50 border-b border-slate-100 cursor-pointer transition";
        trMain.onclick = () => toggleAccordion(`det-${tid}`);
        trMain.innerHTML = `
            <td class="p-4 border-r border-slate-100"><div class="font-bold text-slate-800 text-[13px] leading-tight mb-1">${task.query}</div><div class="text-[10px] uppercase font-bold ${modelBg} border inline-block px-2 py-0.5 rounded">${visualModelName}</div></td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-ws"><span class="animate-pulse text-slate-300">WS...</span></td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-status"><span class="animate-pulse text-blue-500 font-semibold">Ожидание...</span></td>
            <td class="p-4 border-r border-slate-100 text-center" id="${tid}-sent"><span class="text-slate-300">-</span></td>
            <td class="p-4 text-xs" id="${tid}-src"><span class="text-slate-300">-</span></td>
        `;

        const trDet = document.createElement('tr');
        trDet.id = `det-${tid}`; trDet.className = "hidden bg-slate-50/50 shadow-inner";
        trDet.innerHTML = `<td colspan="5"><div class="p-6 text-sm text-slate-700 markdown-body" id="${tid}-content">Загрузка...</div></td>`;
        tbody.prepend(trDet); tbody.prepend(trMain);

        let fullText = '';
        try {
            if (currentSession.wordstatCache[task.query] === undefined) {
                currentSession.wordstatCache[task.query] = fetchWordstatRealAPI(task.query, settings.yandexToken).then(res => {
                    currentSession.queriesResult[task.query].freq = res.freq;
                    return res;
                });
            }
            const wsFreqData = await currentSession.wordstatCache[task.query];
            document.getElementById(`${tid}-ws`).innerHTML = wsFreqData.status;

            if (task.model === 'google-ai' || task.model === 'yandex-alisa') {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-amber-600 font-bold text-[10px] uppercase">Ждет ввода</span>`;
                document.getElementById(`${tid}-content`).innerHTML = `
                    <div class="bg-white p-4 rounded-xl border border-slate-200">
                        <div class="flex justify-between items-center mb-3">
                            <h4 class="font-bold text-slate-800">Ручной сбор данных (${visualModelName})</h4>
                            <button id="btn-open-${tid}" class="bg-indigo-100 text-indigo-700 hover:bg-indigo-200 px-3 py-1.5 rounded text-sm font-semibold transition flex gap-1 items-center">▶ Открыть окно поиска</button>
                        </div>
                        <p class="text-xs text-slate-500 mb-2">Скопируйте текст ответа из открывшегося окна и вставьте его ниже (вместе со ссылками, если они есть):</p>
                        <textarea id="manual-text-${tid}" class="w-full border border-slate-300 rounded-lg p-3 h-32 focus:ring-2 focus:ring-blue-500 outline-none mb-3"></textarea>
                        <button id="btn-save-${tid}" class="bg-blue-600 hover:bg-blue-700 text-white font-bold py-2 px-6 rounded-lg transition">Проанализировать текст</button>
                    </div>
                `;
                
                await new Promise((resolve, reject) => {
                    const abortHandler = () => reject(new DOMException('Aborted', 'AbortError'));
                    abortCtrl.signal.addEventListener('abort', abortHandler);
                    
                    document.getElementById(`btn-open-${tid}`).onclick = (e) => {
                        e.stopPropagation();
                        ipcRenderer.invoke('open-search-browser', { engine: task.model, query: task.query });
                    };
                    
                    document.getElementById(`btn-save-${tid}`).onclick = () => {
                        fullText = document.getElementById(`manual-text-${tid}`).value.trim();
                        if(!fullText) return alert('Введите текст!');
                        document.getElementById(`${tid}-content`).innerHTML = marked.parse(fullText);
                        abortCtrl.signal.removeEventListener('abort', abortHandler);
                        resolve();
                    };
                });
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="animate-pulse text-blue-500 font-semibold">Генерация...</span>`;
                
                const reqBody = { model: task.model, messages: [{role: 'user', content: task.query}], stream: true };
                if (activeProj.useWebSearch) reqBody.plugins = [{ id: "web" }];

                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST', headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(reqBody), signal: abortCtrl.signal
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
            let sentimentResult = '-';
            
            if (wsFreqData.freq > 0) { currentSession.weightTotal += wsFreqData.freq; if(isBrandFound) currentSession.weightedSum += wsFreqData.freq; }

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
                    sentimentResult = sentData.choices[0].message.content.trim().toUpperCase();
                    let col = sentimentResult.includes('ПОЗИТИВ') ? 'text-emerald-600 bg-emerald-100' : sentimentResult.includes('НЕГАТИВ') ? 'text-red-600 bg-red-100' : 'text-slate-600 bg-slate-200';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold px-2 py-1 rounded text-[10px] tracking-wide inline-block">${sentimentResult}</span>`;
                } catch(e) { document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-amber-500 text-[10px]">Ошибка ИИ</span>`; }
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-slate-400 font-bold text-xs">Не найдено</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-slate-300">-</span>`;
            }

            currentSession.queriesResult[task.query].modelsData[task.model] = { found: isBrandFound ? 1 : 0, text: fullText, sentiment: sentimentResult, domains: foundDomains };
            completedTasksCount++;
            document.getElementById('status-progress').innerText = `${completedTasksCount}/${currentSession.totalTasks}`;

        } catch (error) {
            if (error.name === 'AbortError') { taskQueue.unshift(task); trMain.remove(); trDet.remove(); return; } 
            else { 
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-red-500 font-bold text-xs">Ошибка</span>`; 
                completedTasksCount++; 
                document.getElementById('status-progress').innerText = `${completedTasksCount}/${currentSession.totalTasks}`;
            }
        }
    };

    const runWorker = async () => {
        while (taskQueue.length > 0 && !isPaused && !isCancelled) {
            const task = taskQueue.shift(); if (!task) break; await processTask(task);
        }
    };

    const maxWorkers = Math.min(5, Math.max(1, parseInt(activeProj.concurrency) || 1));
    const workers = [];
    for (let i = 0; i < maxWorkers; i++) workers.push(runWorker());

    await Promise.all(workers);

    if (!isPaused && !isCancelled && taskQueue.length === 0) {
        currentSession.vGen = currentSession.totalTasks > 0 ? ((currentSession.successQueries / currentSession.totalTasks) * 100).toFixed(1) : 0;
        currentSession.vWeight = currentSession.weightTotal > 0 ? ((currentSession.weightedSum / currentSession.weightTotal) * 100).toFixed(1) : 0;
        activeProj.sessions.push(currentSession); ipcRenderer.send('save-project', activeProj);
        document.getElementById('status-progress').innerHTML += ' <span class="text-emerald-600 font-bold">(Завершено)</span>';
        resetQueueUI(); btnStart.classList.remove('hidden'); btnStart.innerText = 'Начать новый сбор';
    }
}

// --- ИСТОРИЯ И СНИМКИ (SNAPSHOTS) ---
window.deleteSession = (index, e) => {
    e.stopPropagation();
    if(confirm('Удалить эту сессию съема?')) { activeProj.sessions.splice(index, 1); ipcRenderer.send('save-project', activeProj); renderHistory(); }
}

window.renderHistory = () => {
    document.getElementById('history-snapshot-view').classList.add('hidden');
    document.getElementById('history-main-view').classList.remove('hidden');
    
    if (!activeProj || !activeProj.sessions) return;
    
    const tbody = document.getElementById('history-list-tbody'); tbody.innerHTML = '';
    
    activeProj.sessions.forEach((s, idx) => {
        tbody.innerHTML += `
            <tr class="hover:bg-slate-50 cursor-pointer transition border-b border-slate-100" onclick="openSnapshot(${idx})">
                <td class="p-4 font-semibold text-slate-800 text-sm">${s.date}</td>
                <td class="p-4 text-center text-slate-500 font-medium">${s.totalTasks || 0}</td>
                <td class="p-4 text-center font-bold text-blue-600">${s.vGen}%</td>
                <td class="p-4 text-center font-bold text-emerald-600">${s.vWeight}%</td>
                <td class="p-4 text-center"><button onclick="deleteSession(${idx}, event)" class="bg-red-50 text-red-600 hover:bg-red-100 px-3 py-1.5 rounded text-xs font-bold transition">Удалить</button></td>
            </tr>`;
    });

    let allCompetitors = {};
    activeProj.sessions.forEach(s => { if (s.domainsFound) Object.entries(s.domainsFound).forEach(([dom, count]) => { allCompetitors[dom] = (allCompetitors[dom] || 0) + count; }); });
    const cList = document.getElementById('competitors-list'); cList.innerHTML = '';
    Object.entries(allCompetitors).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([dom, count]) => {
        cList.innerHTML += `<li class="flex justify-between items-center border-b border-slate-100 py-2"><span class="text-slate-700 font-medium">${dom}</span><span class="font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded text-xs">${count}</span></li>`;
    });
    
    drawCharts();
}

window.openSnapshot = (idx) => {
    const s = activeProj.sessions[idx];
    document.getElementById('history-main-view').classList.add('hidden');
    document.getElementById('history-snapshot-view').classList.remove('hidden');
    document.getElementById('snapshot-title').innerText = `Снимок выдачи от ${s.date}`;
    document.getElementById('snap-vgen').innerText = `V (Общая): ${s.vGen}%`;
    document.getElementById('snap-vweight').innerText = `V (Взвешенная): ${s.vWeight}%`;
    
    const tbody = document.getElementById('snapshot-tbody'); tbody.innerHTML = '';
    if(!s.queriesResult) return;
    
    Object.entries(s.queriesResult).forEach(([query, data]) => {
        if(!data.modelsData) return;
        Object.entries(data.modelsData).forEach(([model, mData]) => {
            const tid = `snap-${idx}-${Math.floor(Math.random()*10000)}`;
            const isFound = mData.found === 1;
            const trMain = document.createElement('tr');
            trMain.className = `hover:bg-slate-50 border-b border-slate-100 cursor-pointer transition ${isFound ? 'bg-emerald-50/20' : ''}`;
            trMain.onclick = () => toggleAccordion(`det-${tid}`);
            
            let sentimentUI = `<span class="text-slate-300">-</span>`;
            if (mData.sentiment && mData.sentiment !== '-') {
                let col = mData.sentiment.includes('ПОЗИТИВ') ? 'text-emerald-600 bg-emerald-100' : mData.sentiment.includes('НЕГАТИВ') ? 'text-red-600 bg-red-100' : 'text-slate-600 bg-slate-200';
                sentimentUI = `<span class="${col} font-bold px-2 py-1 rounded text-[10px] tracking-wide inline-block">${mData.sentiment}</span>`;
            }

            const doms = (mData.domains && mData.domains.length > 0) ? mData.domains.map(d => `<span class="inline-block bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded text-[10px] m-0.5">${d}</span>`).join('') : '<span class="text-slate-300">Нет</span>';

            trMain.innerHTML = `
                <td class="p-4 border-r border-slate-100"><div class="font-bold text-slate-800 text-[13px] leading-tight mb-1">${query}</div><div class="text-[10px] uppercase font-bold bg-blue-50 text-blue-700 border border-blue-200 inline-block px-2 py-0.5 rounded">${model}</div></td>
                <td class="p-4 border-r border-slate-100 text-center font-bold text-emerald-600">${data.freq || 0}</td>
                <td class="p-4 border-r border-slate-100 text-center font-bold ${isFound ? 'text-emerald-600' : 'text-slate-400 text-xs'}">${isFound ? 'Найдено' : 'Не найдено'}</td>
                <td class="p-4 border-r border-slate-100 text-center">${sentimentUI}</td>
                <td class="p-4 text-xs">${doms}</td>
            `;

            const trDet = document.createElement('tr');
            trDet.id = `det-${tid}`; trDet.className = "hidden bg-slate-50/50 shadow-inner";
            trDet.innerHTML = `<td colspan="5"><div class="p-6 text-sm text-slate-700 markdown-body">${marked.parse(mData.text || 'Нет текста')}</div></td>`;
            
            tbody.appendChild(trMain); tbody.appendChild(trDet);
        });
    });
}

window.closeSnapshot = () => { renderHistory(); }

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
        dModels.push({ label: model, data: activeProj.sessions.map(s => {
            let total = 0, found = 0;
            if(s.queriesResult) Object.values(s.queriesResult).forEach(qr => { 
                if (qr.modelsData && qr.modelsData[model] !== undefined) { total++; found += qr.modelsData[model].found || 0; } 
            });
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
    box.innerHTML = '<span class="text-indigo-600 animate-pulse font-bold flex items-center gap-2">Gemma анализирует...</span>';
    let dynText = activeProj.sessions.map((s, i) => `Сессия ${i+1} (${s.date}): Общая ${s.vGen}%, Взвешенная ${s.vWeight}%.`).join(' ');
    const lastS = activeProj.sessions[activeProj.sessions.length - 1];
    const dataPrompt = `История съемов: ${dynText}. Главные конкуренты: ${lastS.domainsFound ? Object.keys(lastS.domainsFound).slice(0,10).join(', ') : 'Нет'}. Сделай выводы о динамике.`;

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [ { role: 'system', content: settings.systemPrompt }, { role: 'user', content: dataPrompt } ] }) });
        const data = await res.json(); box.innerHTML = marked.parse(data.choices[0].message.content);
    } catch (e) { box.innerHTML = '<span class="text-red-500 font-bold">Ошибка API</span>'; }
}

init();
