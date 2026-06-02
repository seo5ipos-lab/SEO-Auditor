const { ipcRenderer } = require('electron');

let settings = {}, projects = [], activeProj = null, allModels = [];
let tempSelectedModels = new Set();
let modelsPricing = {};
let globalChartInst = null, modelsChartInst = null;

let taskQueue = [];
let isPaused = false;
let abortCtrl = null;
let currentSession = null;
let completedTasksCount = 0;

async function init() {
    settings = await ipcRenderer.invoke('get-settings');
    if (settings) {
        document.getElementById('set-or').value = settings.openRouterKey || '';
        document.getElementById('set-ws').value = settings.wordstatKey || '';
        document.getElementById('set-prompt').value = settings.systemPrompt || '';
        if (settings.openRouterKey) fetchModelsAsync(settings.openRouterKey);
    }
    loadProjects();
}

document.getElementById('btn-save-settings').addEventListener('click', () => {
    settings.openRouterKey = document.getElementById('set-or').value.trim();
    settings.wordstatKey = document.getElementById('set-ws').value.trim();
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
            // Безопасное извлечение цен, так как у некоторых моделей OpenRouter нет объекта pricing
            modelsPricing[m.id] = { 
                prompt: m.pricing?.prompt || 0, 
                completion: m.pricing?.completion || 0 
            };
        });
        renderModelsList();
    } catch (e) { 
        console.error("Ошибка загрузки моделей:", e); 
    }
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
    
    tempSelectedModels = new Set(activeProj.models);
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
    
    if (allModels.length === 0) return list.innerHTML = '<p class="text-red-500">Модели не загружены. Проверьте API ключ.</p>';
    
    allModels.forEach(m => {
        // ЗАЩИТА: У некоторых моделей OpenRouter отсутствует поле name или id
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
    activeProj.models = Array.from(tempSelectedModels);
    ipcRenderer.send('save-project', activeProj);
    alert('Настройки проекта сохранены!');
}

function extractDomains(text) {
    const regex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g;
    const matches = []; let match;
    while ((match = regex.exec(text)) !== null) { matches.push(match[1].toLowerCase()); }
    return [...new Set(matches)];
}
async function fetchWordstat() { return Math.floor(Math.random() * 5000) + 10; }

// --- УПРАВЛЕНИЕ ОЧЕРЕДЬЮ И СЪЕМ ---
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const btnContinue = document.getElementById('btn-continue');

btnStart.addEventListener('click', async () => {
    // АВТОСОХРАНЕНИЕ: Принудительно сохраняем проект перед стартом
    activeProj.queries = document.getElementById('proj-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    activeProj.models = Array.from(tempSelectedModels);
    ipcRenderer.send('save-project', activeProj);

    if (activeProj.queries.length === 0 || activeProj.models.length === 0) {
        return alert('Внимание: Добавьте хотя бы один поисковый запрос и выберите минимум одну модель (галочкой)!');
    }
    if (!settings.openRouterKey) {
        return alert('Нет API ключа! Перейдите в "Глобальные Настройки" и укажите ключ OpenRouter.');
    }

    document.getElementById('results-tbody').innerHTML = ''; 
    currentSession = {
        date: new Date().toLocaleString(),
        totalTasks: activeProj.queries.length * activeProj.models.length,
        successQueries: 0, weightTotal: 0, weightedSum: 0, domainsFound: {}, queriesResult: {}, totalCost: 0
    };
    
    taskQueue = [];
    completedTasksCount = 0;
    
    for (const q of activeProj.queries) {
        const wsFreq = await fetchWordstat();
        currentSession.queriesResult[q] = { freq: wsFreq, modelsData: {} };
        for (const m of activeProj.models) {
            taskQueue.push({ query: q, model: m, wsFreq: wsFreq });
        }
    }

    startQueue();
});

btnStop.addEventListener('click', () => {
    isPaused = true;
    if (abortCtrl) abortCtrl.abort();
    btnStop.classList.add('hidden');
    btnContinue.classList.remove('hidden');
    document.getElementById('status-progress').innerHTML += ' <span class="text-red-500 font-bold">(Остановлено)</span>';
});

btnContinue.addEventListener('click', () => {
    startQueue();
});

function startQueue() {
    isPaused = false;
    btnStart.classList.add('hidden');
    btnContinue.classList.add('hidden');
    btnStop.classList.remove('hidden');
    processQueue();
}

async function processQueue() {
    const tbody = document.getElementById('results-tbody');
    const brandKeywords = (activeProj.brands || '').split(',').map(b=>b.trim().toLowerCase()).filter(Boolean);
    const myDomains = (activeProj.domains || '').split(',').map(d=>d.trim().toLowerCase()).filter(Boolean);

    while (taskQueue.length > 0 && !isPaused) {
        const task = taskQueue.shift(); 
        abortCtrl = new AbortController();
        const tid = `tr-${Date.now()}-${Math.floor(Math.random()*1000)}`;
        
        const tr = document.createElement('tr');
        tr.id = tid;
        tr.className = "hover:bg-gray-50 border-b";
        tr.innerHTML = `
            <td class="p-3 border-r">
                <div class="font-semibold text-gray-800">${task.query}</div>
                <div class="text-xs text-blue-700 bg-blue-50 inline-block px-1 rounded mt-1">${task.model}</div>
            </td>
            <td class="p-3 border-r" id="${tid}-status"><span class="animate-pulse text-blue-500">Генерация...</span></td>
            <td class="p-3 border-r" id="${tid}-sent"><span class="text-gray-400">-</span></td>
            <td class="p-3 text-xs" id="${tid}-src"><span class="text-gray-400">-</span></td>
        `;
        tbody.prepend(tr);

        let fullText = '';
        try {
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
                            }
                        } catch(e){}
                    }
                }
            }
            
            // Защищенный подсчет стоимости
            const pricing = modelsPricing[task.model] || { prompt: 0, completion: 0 };
            const inCost = (task.query.length / 4) * parseFloat(pricing.prompt || 0);
            const outCost = (fullText.length / 4) * parseFloat(pricing.completion || 0);
            currentSession.totalCost += (inCost + outCost);
            document.getElementById('status-cost').innerText = `$${currentSession.totalCost.toFixed(6)}`;

            const foundDomains = extractDomains(fullText);
            document.getElementById(`${tid}-src`).innerHTML = foundDomains.length > 0 ? foundDomains.join('<br>') : '<span class="text-gray-400">Нет</span>';
            foundDomains.forEach(d => {
                if(!myDomains.includes(d)) currentSession.domainsFound[d] = (currentSession.domainsFound[d] || 0) + 1;
            });

            const isBrandFound = brandKeywords.some(b => fullText.toLowerCase().includes(b)) || foundDomains.some(d => myDomains.includes(d));
            
            // Безопасная запись результата
            if (!currentSession.queriesResult[task.query]) currentSession.queriesResult[task.query] = { freq: task.wsFreq, modelsData: {} };
            currentSession.queriesResult[task.query].modelsData[task.model] = isBrandFound ? 1 : 0;
            
            if (task.wsFreq > 0) {
                currentSession.weightTotal += task.wsFreq;
                if(isBrandFound) currentSession.weightedSum += task.wsFreq;
            }

            if (isBrandFound) {
                currentSession.successQueries++;
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-green-600 font-bold">✓ Обнаружен</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = '<span class="text-blue-500 animate-pulse text-xs">Анализ...</span>';
                
                try {
                    const sentRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [{role: 'user', content: `Определи тональность упоминания "${activeProj.brands}" в тексте: "${fullText}". Ответь 1 словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.`}]})
                    });
                    const sentData = await sentRes.json();
                    const sentiment = sentData.choices[0].message.content.trim();
                    let col = sentiment.includes('ПОЗИТИВ') ? 'text-green-600' : sentiment.includes('НЕГАТИВ') ? 'text-red-600' : 'text-gray-600';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold">${sentiment}</span>`;
                } catch(e) {
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-orange-500 text-xs">Ошибка ИИ</span>`;
                }
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-gray-400 font-bold">✗ Отсутствует</span>`;
                document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-gray-300">-</span>`;
            }

            completedTasksCount++;
            document.getElementById('status-progress').innerText = `${completedTasksCount}/${currentSession.totalTasks}`;

        } catch (error) {
            if (error.name === 'AbortError') {
                taskQueue.unshift(task); 
                tr.remove(); 
                break; 
            } else {
                document.getElementById(`${tid}-status`).innerHTML = `<span class="text-red-600 font-bold">Ошибка API</span>`;
                completedTasksCount++;
            }
        }
    }

    if (!isPaused && taskQueue.length === 0) {
        currentSession.vGen = currentSession.totalTasks > 0 ? ((currentSession.successQueries / currentSession.totalTasks) * 100).toFixed(1) : 0;
        currentSession.vWeight = currentSession.weightTotal > 0 ? ((currentSession.weightedSum / currentSession.weightTotal) * 100).toFixed(1) : 0;
        
        activeProj.sessions.push(currentSession);
        ipcRenderer.send('save-project', activeProj);
        document.getElementById('status-progress').innerText += ' (Съем завершен)';
        
        btnStop.classList.add('hidden');
        btnStart.classList.remove('hidden');
        btnStart.innerText = 'Начать новый съем';
    }
}

// --- ИСТОРИЯ И АНАЛИТИКА ---
window.deleteSession = (index) => {
    if(confirm('Удалить эту сессию съема?')) {
        activeProj.sessions.splice(index, 1);
        ipcRenderer.send('save-project', activeProj);
        renderHistory();
    }
}

window.renderHistory = () => {
    if (!activeProj || !activeProj.sessions) return;
    
    let allQueries = new Set(activeProj.queries || []);
    activeProj.sessions.forEach(s => {
        if(s.queriesResult) Object.keys(s.queriesResult).forEach(q => allQueries.add(q));
    });
    
    const thead = document.getElementById('history-thead');
    const tbody = document.getElementById('history-tbody');
    
    let ths = '<tr><th class="p-2 border-r">Запрос</th><th class="p-2 border-r">WS</th>';
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
        let row = `<tr><td class="p-2 border-r text-sm font-semibold text-gray-700">${q}</td><td class="p-2 border-r text-xs text-gray-400 text-center">WS</td>`;
        activeProj.sessions.forEach(s => {
            if(s.queriesResult && s.queriesResult[q]) {
                const modelsData = s.queriesResult[q].modelsData || {};
                const totalM = Object.keys(modelsData).length;
                const found = Object.values(modelsData).reduce((a,b)=>a+b, 0);
                const perc = totalM > 0 ? ((found/totalM)*100).toFixed(0) : 0;
                row += `<td class="p-2 border-r text-center ${perc > 0 ? 'text-green-600 font-bold' : 'text-gray-400'}">${perc}%</td>`;
            } else { row += `<td class="p-2 border-r text-center text-gray-300">-</td>`; }
        });
        tbody.innerHTML += row + `</tr>`;
    });

    let allCompetitors = {};
    activeProj.sessions.forEach(s => {
        if (s.domainsFound) {
            Object.entries(s.domainsFound).forEach(([dom, count]) => { allCompetitors[dom] = (allCompetitors[dom] || 0) + count; });
        }
    });
    const cList = document.getElementById('competitors-list');
    cList.innerHTML = '';
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
        if(s.queriesResult) {
            Object.values(s.queriesResult).forEach(qr => {
                if(qr.modelsData) Object.keys(qr.modelsData).forEach(m => sessionModels.add(m));
            });
        }
    });

    sessionModels.forEach(model => {
        let data = activeProj.sessions.map(s => {
            let total = 0, found = 0;
            if(s.queriesResult) {
                Object.values(s.queriesResult).forEach(qr => {
                    if (qr.modelsData && qr.modelsData[model] !== undefined) { total++; found += qr.modelsData[model]; }
                });
            }
            return total > 0 ? (found/total)*100 : null;
        });
        datasetsModels.push({ label: model, data: data, borderColor: colors[mIdx % colors.length], tension: 0.3, spanGaps: true });
        mIdx++;
    });

    if (modelsChartInst) modelsChartInst.destroy();
    const ctxM = document.getElementById('chart-models');
    if (ctxM) {
        modelsChartInst = new Chart(ctxM.getContext('2d'), {
            type: 'line',
            data: { labels: labels, datasets: datasetsModels },
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
    } catch (e) {
        box.innerHTML = '<span class="text-red-600">Ошибка API. Проверьте соединение.</span>';
    }
}

init();
