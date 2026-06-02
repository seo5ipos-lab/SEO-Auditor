const { ipcRenderer } = require('electron');

let settings = {}, projects = [], activeProj = null, allModels = [];
let abortCtrl = null;

// 1. ИНИЦИАЛИЗАЦИЯ И НАСТРОЙКИ
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

// Асинхронная загрузка моделей (чтобы не лагал интерфейс)
async function fetchModelsAsync(key) {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${key}` }});
        const data = await res.json();
        allModels = data.data;
        renderModelsList();
    } catch (e) { console.error("Ошибка загрузки моделей"); }
}

// 2. УПРАВЛЕНИЕ ПРОЕКТАМИ
async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = '';
    projects.forEach(p => {
        grid.innerHTML += `
            <div class="bg-white p-5 rounded shadow hover:shadow-md border-t-4 border-blue-500 cursor-pointer relative group" onclick="openProject('${p.id}')">
                <h3 class="font-bold text-lg mb-1">${p.name}</h3>
                <p class="text-xs text-gray-500 mb-2">Бренд: ${p.brands}</p>
                <p class="text-xs text-gray-400">Сессий съема: ${p.sessions ? p.sessions.length : 0}</p>
                <button class="absolute top-2 right-2 text-red-500 hidden group-hover:block" onclick="deleteProject('${p.id}', event)">Удалить</button>
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

// 3. РАБОЧАЯ СРЕДА ПРОЕКТА
window.openProject = (id) => {
    activeProj = projects.find(p => p.id === id);
    if (!activeProj.sessions) activeProj.sessions = [];
    
    document.getElementById('dash-title').innerText = activeProj.name;
    document.getElementById('dash-info').innerText = `Домены: ${activeProj.domains} | Бренд: ${activeProj.brands}`;
    
    document.getElementById('proj-queries').value = activeProj.queries ? activeProj.queries.join('\n') : '';
    renderModelsList();
    renderHistory();
    
    document.querySelectorAll('.view-section').forEach(el => el.classList.remove('active'));
    document.getElementById('view-project-dashboard').classList.add('active');
    switchProjTab('ptab-setup');
}

window.filterModels = () => renderModelsList();

function renderModelsList() {
    const list = document.getElementById('proj-models-list');
    const search = document.getElementById('search-models').value.toLowerCase();
    list.innerHTML = '';
    if (allModels.length === 0) return list.innerHTML = '<p class="text-red-500">Модели не загружены. Проверьте API ключ.</p>';
    
    allModels.forEach(m => {
        if (m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search)) {
            const checked = activeProj && activeProj.models && activeProj.models.includes(m.id) ? 'checked' : '';
            list.innerHTML += `<label class="block mb-1 cursor-pointer hover:bg-gray-100 p-1 rounded"><input type="checkbox" value="${m.id}" class="proj-mod-cb mr-2" ${checked}> <span class="font-semibold text-blue-800">${m.id}</span> <span class="text-xs text-gray-500">(${m.name})</span></label>`;
        }
    });
}

window.saveProjectData = () => {
    activeProj.queries = document.getElementById('proj-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    activeProj.models = Array.from(document.querySelectorAll('.proj-mod-cb:checked')).map(cb => cb.value);
    ipcRenderer.send('save-project', activeProj);
    alert('Настройки проекта сохранены!');
}

// 4. ПАРСЕР ДОМЕНОВ И ЗАГЛУШКА WORDSTAT
function extractDomains(text) {
    const regex = /(?:https?:\/\/)?(?:www\.)?([a-zA-Z0-9-]+\.[a-zA-Z]{2,})/g;
    const matches = []; let match;
    while ((match = regex.exec(text)) !== null) { matches.push(match[1].toLowerCase()); }
    return [...new Set(matches)];
}
async function fetchWordstat() { return Math.floor(Math.random() * 5000) + 10; } // Симуляция

// 5. БОЕВОЙ ДВИЖОК СБОРА
document.getElementById('btn-start').addEventListener('click', async () => {
    if (!activeProj.queries.length || !activeProj.models.length) return alert('Сохраните запросы и модели во вкладке "Настройки"!');
    if (!settings.openRouterKey) return alert('Нет API ключа!');

    const btnStart = document.getElementById('btn-start'); const btnStop = document.getElementById('btn-stop');
    btnStart.disabled = true; btnStop.disabled = false;
    abortCtrl = new AbortController();

    const container = document.getElementById('results-container'); container.innerHTML = '';
    
    let currentSession = {
        date: new Date().toLocaleString(),
        totalQueries: activeProj.queries.length * activeProj.models.length,
        successQueries: 0, weightTotal: 0, weightedSum: 0, domainsFound: {}, queriesResult: {}
    };
    
    let completed = 0;
    const brandKeywords = activeProj.brands.split(',').map(b=>b.trim().toLowerCase()).filter(Boolean);
    const myDomains = activeProj.domains.split(',').map(d=>d.trim().toLowerCase()).filter(Boolean);

    for (const qText of activeProj.queries) {
        if (abortCtrl.signal.aborted) break;
        const wsFreq = await fetchWordstat(qText);
        currentSession.queriesResult[qText] = { freq: wsFreq, modelsData: {} };

        for (const model of activeProj.models) {
            if (abortCtrl.signal.aborted) break;
            
            const tid = `t-${Date.now()}-${Math.floor(Math.random()*1000)}`;
            container.innerHTML += `
                <details class="bg-white rounded shadow mb-2 group border-l-4 border-gray-300" id="${tid}-box">
                    <summary class="p-4 bg-gray-50 font-semibold flex justify-between items-center group-open:bg-blue-50 transition">
                        <span>${qText} <span class="text-xs bg-gray-200 px-2 py-1 rounded ml-2 font-normal text-blue-800">${model}</span></span>
                        <div class="text-right text-sm">
                            <span id="${tid}-status" class="text-blue-600 animate-pulse">Генерация...</span>
                            <div id="${tid}-sent" class="text-xs mt-1"></div>
                        </div>
                    </summary>
                    <div class="p-4 text-sm text-gray-800 markdown-body border-t bg-white" id="${tid}-content"></div>
                    <div class="p-3 bg-slate-100 text-xs text-gray-600 border-t" id="${tid}-domains"></div>
                </details>`;

            const cBox = document.getElementById(`${tid}-content`);
            const sBox = document.getElementById(`${tid}-status`);
            let fullText = '';

            try {
                // ВАЖНО: Мы не шлем системный промпт сюда! Только чистый сбор данных.
                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: model, messages: [{role: 'user', content: qText}], stream: true }),
                    signal: abortCtrl.signal
                });

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
                                if (parsed.choices[0].delta.content) {
                                    fullText += parsed.choices[0].delta.content;
                                    // Рендерим Markdown в реальном времени
                                    cBox.innerHTML = marked.parse(fullText);
                                }
                            } catch(e){}
                        }
                    }
                }
                sBox.innerText = 'Успешно'; sBox.className = 'text-green-600';
                
                // Парсинг источников и ссылок
                const foundDomains = extractDomains(fullText);
                document.getElementById(`${tid}-domains`).innerHTML = `<b>Найденные ссылки:</b> ${foundDomains.join(', ') || 'Нет ссылок'}`;
                foundDomains.forEach(d => {
                    if(!myDomains.includes(d)) currentSession.domainsFound[d] = (currentSession.domainsFound[d] || 0) + 1;
                });

                // Анализ бренда
                const isBrandFound = brandKeywords.some(b => fullText.toLowerCase().includes(b)) || foundDomains.some(d => myDomains.includes(d));
                currentSession.queriesResult[qText].modelsData[model] = isBrandFound ? 1 : 0;
                
                if (wsFreq > 0) {
                    currentSession.weightTotal += wsFreq;
                    if(isBrandFound) currentSession.weightedSum += wsFreq;
                }

                if (isBrandFound) {
                    currentSession.successQueries++;
                    document.getElementById(`${tid}-box`).classList.replace('border-gray-300', 'border-green-500');
                    document.getElementById(`${tid}-sent`).innerHTML = '<span class="text-blue-500 animate-pulse">Проверка тональности...</span>';
                    
                    // Запрос тональности к дешевой модели (как просил юзер - gemma-2-27b-it)
                    const sentRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'google/gemma-2-27b-it', messages: [{role: 'user', content: `Определи тональность упоминания "${activeProj.brands}" в тексте: "${fullText}". Ответь 1 словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.`}]})
                    });
                    const sentData = await sentRes.json();
                    const sentiment = sentData.choices[0].message.content.trim();
                    let col = sentiment.includes('ПОЗИТИВ') ? 'text-green-600' : sentiment.includes('НЕГАТИВ') ? 'text-red-600' : 'text-gray-600';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold">${sentiment}</span>`;
                } else {
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-gray-400">Бренд не найден</span>`;
                }

            } catch (error) {
                if (error.name !== 'AbortError') { sBox.innerText = 'Ошибка API'; sBox.className = 'text-red-600 font-bold'; }
            }
            completed++;
            document.getElementById('status-progress').innerText = `${completed}/${currentSession.totalQueries}`;
        }
    }

    // Сохранение сессии
    if (!abortCtrl.signal.aborted) {
        currentSession.vGen = ((currentSession.successQueries / currentSession.totalQueries) * 100).toFixed(1);
        currentSession.vWeight = currentSession.weightTotal > 0 ? ((currentSession.weightedSum / currentSession.weightTotal) * 100).toFixed(1) : 0;
        
        activeProj.sessions.push(currentSession);
        ipcRenderer.send('save-project', activeProj);
        renderHistory(); // Обновляем графики
        document.getElementById('status-progress').innerText += ' (Съем завершен)';
    }

    btnStart.disabled = false; btnStop.disabled = true;
});

document.getElementById('btn-stop').addEventListener('click', () => {
    if (abortCtrl) abortCtrl.abort();
    document.getElementById('btn-start').disabled = false; document.getElementById('btn-stop').disabled = true;
});

// 6. ИСТОРИЯ И ИИ-АНАЛИТИКА
function renderHistory() {
    if (!activeProj || !activeProj.sessions || activeProj.sessions.length === 0) return;
    
    // Отрисовка таблицы (Даты/Запросы)
    const thead = document.getElementById('history-thead');
    const tbody = document.getElementById('history-tbody');
    thead.innerHTML = '<tr><th class="p-2">Запрос</th><th class="p-2">WS</th>' + activeProj.sessions.map(s => `<th class="p-2">${s.date.split(',')[0]}<br><span class="text-xs text-blue-500 font-normal">V: ${s.vGen}%</span></th>`).join('') + '</tr>';
    
    tbody.innerHTML = '';
    activeProj.queries.forEach(q => {
        let row = `<tr class="border-b"><td class="p-2 font-semibold">${q}</td><td class="p-2 text-xs text-gray-400">WS</td>`;
        activeProj.sessions.forEach(s => {
            if(s.queriesResult[q]) {
                const totalM = Object.keys(s.queriesResult[q].modelsData).length;
                const found = Object.values(s.queriesResult[q].modelsData).reduce((a,b)=>a+b, 0);
                const perc = totalM > 0 ? ((found/totalM)*100).toFixed(0) : 0;
                row += `<td class="p-2 ${perc > 0 ? 'text-green-600 font-bold' : 'text-gray-400'}">${perc}%</td>`;
            } else { row += `<td class="p-2">-</td>`; }
        });
        tbody.innerHTML += row + `</tr>`;
    });

    // Отрисовка Топ Конкурентов (со всех сессий)
    let allCompetitors = {};
    activeProj.sessions.forEach(s => {
        Object.entries(s.domainsFound).forEach(([dom, count]) => {
            allCompetitors[dom] = (allCompetitors[dom] || 0) + count;
        });
    });
    const cList = document.getElementById('competitors-list');
    cList.innerHTML = '';
    Object.entries(allCompetitors).sort((a,b)=>b[1]-a[1]).slice(0, 15).forEach(([dom, count]) => {
        cList.innerHTML += `<li class="flex justify-between border-b py-1"><span>${dom}</span><span class="font-bold text-blue-600">${count}</span></li>`;
    });
}

// Финальный Анализ (применяем Системный Промпт)
window.runFinalAnalysis = async () => {
    if (!activeProj.sessions.length) return alert('Сначала проведите хотя бы один съем данных!');
    if (!settings.openRouterKey) return alert('Нет API ключа!');
    
    const lastSession = activeProj.sessions[activeProj.sessions.length - 1];
    const box = document.getElementById('final-analysis-box');
    box.classList.remove('hidden');
    box.innerHTML = '<span class="text-purple-600 animate-pulse font-bold">Gemma 2 анализирует данные сессии...</span>';

    const dataPrompt = `Данные последнего съема: Общая видимость: ${lastSession.vGen}%. Взвешенная видимость: ${lastSession.vWeight}%. Основные конкуренты (домены): ${Object.keys(lastSession.domainsFound).slice(0,10).join(', ')}.`;

    try {
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                model: 'google/gemma-2-27b-it', // Модель для аналитики
                messages: [
                    { role: 'system', content: settings.systemPrompt },
                    { role: 'user', content: dataPrompt }
                ] 
            })
        });
        const data = await res.json();
        // Рендерим Markdown аналитики
        box.innerHTML = marked.parse(data.choices[0].message.content);
    } catch (e) {
        box.innerHTML = '<span class="text-red-600">Ошибка запроса к ИИ. Проверьте соединение или доступность модели в OpenRouter.</span>';
    }
}

init();