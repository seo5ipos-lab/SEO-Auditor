const { ipcRenderer } = require('electron');

// ПЛАГИН ДЛЯ БЕЛОГО ФОНА ГРАФИКОВ ПРИ ЭКСПОРТЕ В EXCEL
Chart.register({
    id: 'customCanvasBackgroundColor',
    beforeDraw: (chart) => {
        const ctx = chart.canvas.getContext('2d');
        ctx.save();
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
    }
});

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
            <div class="bg-white p-5 rounded shadow hover:shadow-md border-t-4 border-blue-500 cursor-pointer relative group" onclick="openProject('${p.id}')">
                <h3 class="font-bold text-lg mb-1">${p.name || 'Без названия'}</h3>
                <p class="text-xs text-gray-500 mb-2">Бренд: ${p.brands || 'Не указан'}</p>
                <p class="text-xs text-gray-400">Сессий съема: ${p.sessions ? p.sessions.length : 0}</p>
                <button class="absolute top-2 right-2 text-red-500 hidden group-hover:block bg-red-100 px-2 rounded" onclick="deleteProject('${p.id}', event)">Удалить</button>
            </div>`;
    });
}

window.openProjectModal = () => {
    document.getElementById('p-id').value = Date.now().toString();
    document.getElementById('p-name').value = '';
    document.getElementById('p-domains').value = '';
    document.getElementById('p-brands').value = '';
    document.getElementById('modal-project').classList.remove('hidden');
}

window.createNewProject = () => {
    const proj = {
        id: document.getElementById('p-id').value,
        name: document.getElementById('p-name').value,
        domains: document.getElementById('p-domains').value,
        brands: document.getElementById('p-brands').value,
        queries: [], models: [], sessions: []
    };
    ipcRenderer.send('save-project', proj);
    document.getElementById('modal-project').classList.add('hidden');
    loadProjects();
}

window.deleteProject = (id, e) => {
    e.stopPropagation();
    if(confirm('Точно удалить проект и всю его историю?')) { ipcRenderer.send('delete-project', id); loadProjects(); }
}

window.openProject = (id) => {
    activeProj = projects.find(p => p.id === id);
    if (!activeProj.sessions) activeProj.sessions = [];
    if (!activeProj.queries) activeProj.queries = [];
    if (!activeProj.models) activeProj.models = [];
    
    document.getElementById('dash-title').innerText = activeProj.name || 'Проект';
    document.getElementById('dash-info').innerText = `Домены: ${activeProj.domains} | Бренд: ${activeProj.brands}`;
    document.getElementById('proj-queries').value = activeProj.queries.join('\n');
    
    document.getElementById('cb-google-ai').checked = activeProj.models.includes('google-ai');
    document.getElementById('cb-yandex-alisa').checked = activeProj.models.includes('yandex-alisa');
    
    tempSelectedModels = new Set(activeProj.models.filter(m => m !== 'google-ai' && m !== 'yandex-alisa'));
    document.getElementById('search-models').value = '';
    renderModelsList();
    
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-project-dashboard').classList.add('active');
    switchProjTab('ptab-setup');
}

document.getElementById('search-models').addEventListener('input', () => renderModelsList());

function renderModelsList() {
    const list = document.getElementById('proj-models-list');
    const search = document.getElementById('search-models').value.toLowerCase();
    list.innerHTML = '';
    if (allModels.length === 0) return list.innerHTML = '<p class="text-red-500">Модели не загружены.</p>';
    
    allModels.forEach(m => {
        const mId = m.id ? m.id.toLowerCase() : '';
        const mName = m.name ? m.name.toLowerCase() : '';
        if (mId.includes(search) || mName.includes(search)) {
            const checked = tempSelectedModels.has(m.id) ? 'checked' : '';
            const label = document.createElement('label');
            label.className = 'block mb-1 cursor-pointer hover:bg-gray-100 p-1 rounded flex items-center';
            label.innerHTML = `<input type="checkbox" value="${m.id}" class="mr-2" ${checked}> <span class="font-semibold text-blue-800 mr-2">${m.id}</span> <span class="text-xs text-gray-500 truncate">(${m.name || 'Без названия'})</span>`;
            
            label.querySelector('input').addEventListener('change', (e) => {
                if (e.target.checked) tempSelectedModels.add(m.id);
                else tempSelectedModels.delete(m.id);
            });
            list.appendChild(label);
        }
    });
}

window.saveProjectData = () => {
    activeProj.queries = document.getElementById('proj-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    
    const nativeModels = [];
    if (document.getElementById('cb-google-ai').checked) nativeModels.push('google-ai');
    if (document.getElementById('cb-yandex-alisa').checked) nativeModels.push('yandex-alisa');
    
    activeProj.models = [...Array.from(tempSelectedModels), ...nativeModels];
    ipcRenderer.send('save-project', activeProj);
    alert('Настройки проекта сохранены!');
}

function extractDomains(text) {
    const regex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g;
    const matches = []; let match;
    while ((match = regex.exec(text)) !== null) { matches.push(match[1].toLowerCase()); }
    return [...new Set(matches)];
}

async function fetchWordstatRealAPI(query, token) {
    if (!token) return { freq: 0, status: '<span class="text-red-500 text-xs">Нет токена</span>' };
    try {
        const url = 'https://api.direct.yandex.ru/v4/json/';
        const reqOpts = (method, param) => ({
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ method: method, param: param, token: token })
        });

        const createRes = await fetch(url, reqOpts('CreateNewWordstatReport', { Phrases: [query], GeoID: [225] }));
        const createData = await createRes.json();
        
        if (createData.error_code) {
            return { freq: 0, status: `<span class="text-red-600 font-bold text-[10px]" title="${createData.error_str}">Код: ${createData.error_code}</span>` };
        }
        
        const reportId = createData.data;
        let isDone = false;
        let attempts = 0;
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
            return { freq: freq, status: `<span class="text-green-600 font-bold">${freq}</span>` };
        } else {
            return { freq: 0, status: '<span class="text-orange-500 text-[10px]">Таймаут WS</span>' };
        }
    } catch (e) {
        return { freq: 0, status: `<span class="text-red-500 text-[10px]" title="${e.message}">Сбой сети</span>` };
    }
}

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
        date: new Date().toLocaleString(),
        totalTasks: activeProj.queries.length * activeProj.models.length,
        successQueries: 0, weightTotal: 0, weightedSum: 0, domainsFound: {}, queriesResult: {}, totalCost: 0
    };
    
    taskQueue = [];
    completedTasksCount = 0;
    isCancelled = false;
    const wordstatCache = {};

    for (const q of activeProj.queries) {
        currentSession.queriesResult[q] = { freq: 0, modelsData: {} };
        for (const m of activeProj.models) { taskQueue.push({ query: q, model: m }); }
    }
    startQueue(wordstatCache);
});

btnStop.addEventListener('click', () => {
    isPaused = true;
    if (abortCtrl) abortCtrl.abort();
    btnStop.classList.add('hidden');
    btnContinue.classList.remove('hidden');
    document.getElementById('status-progress').innerHTML += ' <span class="text-yellow-600 font-bold">(Пауза)</span>';
});

btnContinue.addEventListener('click', () => { startQueue(currentSession.wordstatCache || {}); });

btnCancel.addEventListener('click', () => {
    if(confirm('Отменить задачу? Данные не будут сохранены в историю.')) {
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
        let modelBg = 'bg-blue-100 text-blue-700';
        if (task.model === 'google-ai') { visualModelName = 'Google AI'; modelBg = 'bg-green-100 text-green-700'; }
        if (task.model === 'yandex-alisa') { visualModelName = 'Yandex Нейро'; modelBg = 'bg-red-100 text-red-700'; }

        const trMain = document.createElement('tr');
        trMain.className = "hover:bg-blue-50 border-b cursor-pointer transition";
        trMain.onclick = () => toggleAccordion(`det-${tid}`);
        trMain.innerHTML = `
            <td class="p-3 border-r">
                <div class="font-semibold text-gray-800">${task.query}</div>
                <div class="text-xs ${modelBg} inline-block px-2 py-0.5 rounded mt-1">${visualModelName}</div>
            </td>
            <td class="p-3 border-r text-center" id="${tid}-ws"><span class="animate-pulse text-gray-400">WS...</span></td>
            <td class="p-3 border-r text-center" id="${tid}-status"><span class="animate-pulse text-blue-500">Генерация...</span></td>
            <td class="p-3 border-r text-center" id="${tid}-sent"><span class="text-gray-400">-</span></td>
            <td class="p-3 text-xs overflow-hidden" id="${tid}-src"><span class="text-gray-400">-</span></td>
        `;

        const trDet = document.createElement('tr');
        trDet.id = `det-${tid}`;
        trDet.className = "hidden bg-white border-b";
        trDet.innerHTML = `<td colspan="5"><div class="p-4 text-sm text-gray-700 markdown-body" id="${tid}-content">Ожидание данных...</div></td>`;

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

            if (task.model === 'google-ai' || task.model === 'yandex-alisa') {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="animate-pulse text-purple-500 font-bold">Окно парсера...</span>`;
                const parseRes = await ipcRenderer.invoke('parse-search-engine', { engine: task.model, query: task.query });
                if (parseRes.error) throw new Error(parseRes.error);
                
                fullText = parseRes.text || '';
                document.getElementById(`${tid}-content`).innerHTML = marked.parse(fullText);
            } else {
                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: task.model, messages: [{role: 'user', content: task.query}], stream: true }),
                    signal: abortCtrl.signal
                });

                if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);

                const reader = res.body.getReader(); const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
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
                const inCost = (task.query.length / 4) * parseFloat(pricing.prompt || 0);
                const outCost = (fullText.length / 4) * parseFloat(pricing.completion || 0);
                currentSession.totalCost += (inCost + outCost);
                document.getElementById('status-cost').innerText = `$${currentSession.totalCost.toFixed(6)}`;
            }

            const foundDomains = extractDomains(fullText);
            document.getElementById(`${tid}-src`).innerHTML = foundDomains.length > 0 ? foundDomains.join(', ') : '<span class="text-gray-400">Нет</span>';
            foundDomains.forEach(d => { if(!myDomains.includes(d)) currentSession.domainsFound[d] = (currentSession.domainsFound[d] || 0) + 1; });

            const isBrandFound = brandKeywords.some(b => fullText.toLowerCase().includes(b)) || foundDomains.some(d => myDomains.includes(d));
            let sentimentStr = '-';
            
            if (wsFreqData.freq > 0) {
                currentSession.weightTotal += wsFreqData.freq;
                if(isBrandFound) currentSession.weightedSum += wsFreqData.freq;
            }

            if (isBrandFound) {
                currentSession.successQueries++;
                trMain.classList.replace('hover:bg-blue-50', 'hover:bg-green-50');
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-green-600 font-bold">✓ Да</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = '<span class="text-blue-500 animate-pulse text-xs">Анализ...</span>';
                
                try {
                    const sentRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [{role: 'user', content: `Определи тональность упоминания "${activeProj.brands}" в тексте: "${fullText}". Ответь 1 словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.`}]})
                    });
                    const sentData = await sentRes.json();
                    const sentiment = sentData.choices[0].message.content.trim();
                    sentimentStr = sentiment;
                    let col = sentiment.includes('ПОЗИТИВ') ? 'text-green-600' : sentiment.includes('НЕГАТИВ') ? 'text-red-600' : 'text-gray-600';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold">${sentiment}</span>`;
                } catch(e) {
                    sentimentStr = 'Ошибка ИИ';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-orange-500 text-xs">Ошибка ИИ</span>`;
                }
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-gray-400 font-bold">✗ Нет</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-gray-300">-</span>`;
            }

            currentSession.queriesResult[task.query].modelsData[task.model] = {
                found: isBrandFound ? 1 : 0,
                sentiment: sentimentStr,
                domains: foundDomains
            };

            completedTasksCount++;
            document.getElementById('status-progress').innerText = `${completedTasksCount}/${currentSession.totalTasks}`;

        } catch (error) {
            if (error.name === 'AbortError') {
                taskQueue.unshift(task); trMain.remove(); trDet.remove(); break; 
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-red-600 font-bold">Ошибка</span>`;
                completedTasksCount++;
            }
        }
    }

    if (!isPaused && !isCancelled && taskQueue.length === 0) {
        currentSession.vGen = currentSession.totalTasks > 0 ? ((currentSession.successQueries / currentSession.totalTasks) * 100).toFixed(1) : 0;
        currentSession.vWeight = currentSession.weightTotal > 0 ? ((currentSession.weightedSum / currentSession.weightTotal) * 100).toFixed(1) : 0;
        activeProj.sessions.push(currentSession);
        ipcRenderer.send('save-project', activeProj);
        document.getElementById('status-progress').innerText += ' (Съем завершен)';
        resetQueueUI(); btnStart.classList.remove('hidden'); btnStart.innerText = 'Начать новый съем';
    }
}

window.deleteSession = (index) => {
    if(confirm('Удалить эту сессию съема?')) {
        activeProj.sessions.splice(index, 1); ipcRenderer.send('save-project', activeProj); renderHistory();
    }
}

window.renderHistory = () => {
    if (!activeProj || !activeProj.sessions) return;
    let allQueries = new Set(activeProj.queries || []);
    activeProj.sessions.forEach(s => { if(s.queriesResult) Object.keys(s.queriesResult).forEach(q => allQueries.add(q)); });
    
    const thead = document.getElementById('history-thead');
    const tbody = document.getElementById('history-tbody');
    
    let ths = '<tr><th class="p-2 border-r">Запрос</th><th class="p-2 border-r text-center">Частотность</th>';
    activeProj.sessions.forEach((s, idx) => {
        ths += `<th class="p-2 text-center border-r bg-white min-w-[120px]">
            <div class="text-xs text-gray-500 mb-1">${s.date}</div>
            <div class="text-blue-600 font-bold">V: ${s.vGen}%</div>
            <button onclick="deleteSession(${idx})" class="text-[10px] text-red-500 hover:underline mt-1">Удалить</button>
        </th>`;
    });
    thead.innerHTML = ths + '</tr>';
    tbody.innerHTML = '';
    
    Array.from(allQueries).forEach(q => {
        let latestFreq = 'WS';
        for(let i = activeProj.sessions.length - 1; i >= 0; i--) {
            if(activeProj.sessions[i].queriesResult[q] && activeProj.sessions[i].queriesResult[q].freq) {
                latestFreq = activeProj.sessions[i].queriesResult[q].freq; break;
            }
        }
        let row = `<tr><td class="p-2 border-r text-sm font-semibold text-gray-700">${q}</td><td class="p-2 border-r text-xs font-bold text-blue-600 text-center">${latestFreq}</td>`;
        activeProj.sessions.forEach(s => {
            if(s.queriesResult && s.queriesResult[q]) {
                const mData = s.queriesResult[q].modelsData || {};
                const totalM = Object.keys(mData).length;
                let found = 0;
                Object.values(mData).forEach(v => {
                    if (typeof v === 'number') found += v;
                    else if (v && typeof v === 'object') found += (v.found || 0);
                });
                const perc = totalM > 0 ? ((found/totalM)*100).toFixed(0) : 0;
                row += `<td class="p-2 border-r text-center ${perc > 0 ? 'text-green-600 font-bold' : 'text-gray-400'}">${perc}%</td>`;
            } else { row += `<td class="p-2 border-r text-center text-gray-300">-</td>`; }
        });
        tbody.innerHTML += row + `</tr>`;
    });

    let allCompetitors = {};
    activeProj.sessions.forEach(s => {
        if (s.domainsFound) Object.entries(s.domainsFound).forEach(([dom, count]) => { allCompetitors[dom] = (allCompetitors[dom] || 0) + count; });
    });
    const cList = document.getElementById('competitors-list'); cList.innerHTML = '';
    Object.entries(allCompetitors).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([dom, count]) => {
        cList.innerHTML += `<li class="flex justify-between border-b py-1"><span>${dom}</span><span class="font-bold text-blue-600">${count}</span></li>`;
    });
    drawCharts();
}

function drawCharts() {
    if (!activeProj || !activeProj.sessions || activeProj.sessions.length === 0) return;
    const labels = activeProj.sessions.map(s => s.date.split(',')[0]);
    const vGenData = activeProj.sessions.map(s => parseFloat(s.vGen || 0));
    const vWeightData = activeProj.sessions.map(s => parseFloat(s.vWeight || 0));

    if (globalChartInst) globalChartInst.destroy();
    const ctxG = document.getElementById('chart-global');
    if (ctxG) {
        globalChartInst = new Chart(ctxG.getContext('2d'), {
            type: 'line',
            data: { labels: labels, datasets: [
                { label: 'Общая видимость (%)', data: vGenData, borderColor: '#2563eb', tension: 0.3 },
                { label: 'Взвешенная видимость (%)', data: vWeightData, borderColor: '#16a34a', tension: 0.3 }
            ]},
            options: { responsive: true, scales: { y: { min: 0, max: 100 } } }
        });
    }

    let datasetsModels = [];
    let colors = ['#8b5cf6', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899'];
    let mIdx = 0;
    let sessionModels = new Set();
    
    activeProj.sessions.forEach(s => {
        if(s.queriesResult) Object.values(s.queriesResult).forEach(qr => {
            if(qr.modelsData) Object.keys(qr.modelsData).forEach(m => sessionModels.add(m));
        });
    });

    sessionModels.forEach(model => {
        let data = activeProj.sessions.map(s => {
            let total = 0, found = 0;
            if(s.queriesResult) Object.values(s.queriesResult).forEach(qr => {
                if (qr.modelsData && qr.modelsData[model] !== undefined) {
                    total++;
                    let v = qr.modelsData[model];
                    found += (typeof v === 'number' ? v : (v.found || 0));
                }
            });
            return total > 0 ? (found/total)*100 : null;
        });
        
        let visualLabel = model;
        if (model === 'google-ai') visualLabel = 'Google AI';
        if (model === 'yandex-alisa') visualLabel = 'Yandex Нейро';
        
        datasetsModels.push({ label: visualLabel, data: data, borderColor: colors[mIdx % colors.length], tension: 0.3, spanGaps: true });
        mIdx++;
    });

    if (modelsChartInst) modelsChartInst.destroy();
    const ctxM = document.getElementById('chart-models');
    if (ctxM) {
        modelsChartInst = new Chart(ctxM.getContext('2d'), {
            type: 'line', data: { labels: labels, datasets: datasetsModels },
            options: { responsive: true, scales: { y: { min: 0, max: 100 } } }
        });
    }
}

window.runFinalAnalysis = async () => {
    if (!activeProj.sessions || !activeProj.sessions.length) return alert('Сначала проведите съемы данных!');
    if (!settings.openRouterKey) return alert('Нет API ключа!');
    
    const box = document.getElementById('final-analysis-box');
    box.classList.remove('hidden');
    box.innerHTML = '<span class="text-purple-600 animate-pulse font-bold">Gemma собирает и анализирует исторические данные...</span>';

    let dynamicsText = activeProj.sessions.map((s, i) => `Сессия ${i+1} (${s.date}): Общая видимость ${s.vGen}%, Взвешенная ${s.vWeight}%.`).join(' ');
    const lastS = activeProj.sessions[activeProj.sessions.length - 1];
    const domainsStr = lastS.domainsFound ? Object.keys(lastS.domainsFound).slice(0,10).join(', ') : 'Нет данных';
    const dataPrompt = `История съемов: ${dynamicsText}. Главные конкуренты последней сессии: ${domainsStr}. Сделай выводы о динамике.`;

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: 'google/gemma-2-27b-it',
                messages: [ { role: 'system', content: settings.systemPrompt }, { role: 'user', content: dataPrompt } ] 
            })
        });
        const data = await res.json();
        box.innerHTML = marked.parse(data.choices[0].message.content);
    } catch (e) { box.innerHTML = '<span class="text-red-600">Ошибка API. Проверьте соединение.</span>'; }
}

// --- НОВАЯ ФУНКЦИЯ ЭКСПОРТА В EXCEL ---
window.exportToExcel = async () => {
    if (!activeProj || !activeProj.sessions || activeProj.sessions.length === 0) {
        return alert('Нет данных для выгрузки. Сначала проведите хотя бы один съем данных!');
    }

    try {
        const wb = new ExcelJS.Workbook();
        wb.creator = 'SEO Auditor PRO';

        // Лист 1: Сводка и Графики
        const wsSummary = wb.addWorksheet('Сводка и Графики');
        wsSummary.getCell('A1').value = 'Отчет по проекту: ' + (activeProj.name || 'Без названия');
        wsSummary.getCell('A1').font = { size: 16, bold: true };
        wsSummary.getCell('A2').value = `Бренд: ${activeProj.brands || '-'} | Домены: ${activeProj.domains || '-'}`;
        wsSummary.getCell('A2').font = { size: 12, italic: true };

        if (globalChartInst && modelsChartInst) {
            // Конвертируем графики в картинки (благодаря плагину фон будет белым)
            const globalBase64 = globalChartInst.toBase64Image().split(',')[1];
            const globalImgId = wb.addImage({ base64: globalBase64, extension: 'png' });
            wsSummary.addImage(globalImgId, 'A4:G20');

            const modelsBase64 = modelsChartInst.toBase64Image().split(',')[1];
            const modelsImgId = wb.addImage({ base64: modelsBase64, extension: 'png' });
            wsSummary.addImage(modelsImgId, 'H4:N20');
        }

        // Лист 2: История съемов (Таблица)
        const wsHistory = wb.addWorksheet('Динамика по сессиям');
        let histCols = [
            { header: 'Запрос', key: 'query', width: 40 },
            { header: 'Частотность (WS)', key: 'freq', width: 15 }
        ];
        activeProj.sessions.forEach((s, i) => {
            histCols.push({ header: `Сессия ${i+1} (${s.date.split(',')[0]})`, key: `s${i}`, width: 25 });
        });
        wsHistory.columns = histCols;
        wsHistory.getRow(1).font = { bold: true };

        let allQueries = new Set();
        activeProj.sessions.forEach(s => { if(s.queriesResult) Object.keys(s.queriesResult).forEach(q => allQueries.add(q)); });

        Array.from(allQueries).forEach(q => {
            let rowData = { query: q, freq: 0 };
            for(let i = activeProj.sessions.length - 1; i >= 0; i--) {
                if(activeProj.sessions[i].queriesResult[q] && activeProj.sessions[i].queriesResult[q].freq) {
                    rowData.freq = activeProj.sessions[i].queriesResult[q].freq; break;
                }
            }
            activeProj.sessions.forEach((s, idx) => {
                let val = '-';
                if(s.queriesResult && s.queriesResult[q]) {
                    const mData = s.queriesResult[q].modelsData || {};
                    const totalM = Object.keys(mData).length;
                    let found = 0;
                    Object.values(mData).forEach(mVal => {
                        if (typeof mVal === 'number') found += mVal;
                        else if (mVal && typeof mVal === 'object') found += (mVal.found || 0);
                    });
                    const perc = totalM > 0 ? ((found/totalM)*100).toFixed(0) : 0;
                    val = `${perc}%`;
                }
                rowData[`s${idx}`] = val;
            });
            wsHistory.addRow(rowData);
        });

        // Лист 3: Детализация (Сырые данные всех съемов)
        const wsDetails = wb.addWorksheet('Детализация данных');
        wsDetails.columns = [
            { header: 'Дата съема', key: 'date', width: 20 },
            { header: 'Запрос', key: 'query', width: 40 },
            { header: 'Модель (ИИ)', key: 'model', width: 20 },
            { header: 'Найдено?', key: 'found', width: 10 },
            { header: 'Тональность', key: 'sentiment', width: 15 },
            { header: 'Собранные источники (Домены)', key: 'domains', width: 60 }
        ];
        wsDetails.getRow(1).font = { bold: true };

        activeProj.sessions.forEach(s => {
            if(s.queriesResult) {
                Object.entries(s.queriesResult).forEach(([query, qData]) => {
                    if(qData.modelsData) {
                        Object.entries(qData.modelsData).forEach(([model, mVal]) => {
                            let isFound = 0;
                            let sent = '-';
                            let doms = '-';
                            if (typeof mVal === 'number') {
                                isFound = mVal;
                            } else if (mVal && typeof mVal === 'object') {
                                isFound = mVal.found || 0;
                                sent = mVal.sentiment || '-';
                                if (mVal.domains && mVal.domains.length) doms = mVal.domains.join(', ');
                            }
                            wsDetails.addRow({
                                date: s.date,
                                query: query,
                                model: model,
                                found: isFound ? 'Да' : 'Нет',
                                sentiment: sent,
                                domains: doms
                            });
                        });
                    }
                });
            }
        });

        // Генерируем файл и вызываем скачивание в браузере (через Blob)
        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        // Очищаем имя от запрещенных символов для файла
        const safeName = (activeProj.name || 'Project').replace(/[^a-z0-9а-яё]/gi, '_');
        a.download = `SEO_Auditor_Report_${safeName}.xlsx`;
        
        a.click();
        window.URL.revokeObjectURL(url);

    } catch (e) {
        console.error(e);
        alert('Произошла ошибка при экспорте в Excel!');
    }
}

init();