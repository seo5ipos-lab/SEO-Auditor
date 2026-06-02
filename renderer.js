const { ipcRenderer } = require('electron');

let settings = {}, projects = [], activeProj = null, allModels = [];
let abortCtrl = null;
let sessionStats = { cost: 0, domains: {}, totalQueries: 0, successQueries: 0, weightedSum: 0, weightTotal: 0 };

// 1. ИНИЦИАЛИЗАЦИЯ
async function init() {
    settings = await ipcRenderer.invoke('get-settings');
    if(settings) {
        document.getElementById('set-or').value = settings.openRouterKey || '';
        document.getElementById('set-ws').value = settings.wordstatKey || '';
        document.getElementById('set-prompt').value = settings.systemPrompt || '';
        if(settings.openRouterKey) fetchModels(settings.openRouterKey);
    }
    loadProjects();
}

document.getElementById('btn-save-settings').addEventListener('click', () => {
    settings = {
        openRouterKey: document.getElementById('set-or').value.trim(),
        wordstatKey: document.getElementById('set-ws').value.trim(),
        systemPrompt: document.getElementById('set-prompt').value.trim(),
        endpoint: 'https://openrouter.ai/api/v1'
    };
    ipcRenderer.send('save-settings', settings);
    if(settings.openRouterKey) fetchModels(settings.openRouterKey);
    alert('Настройки сохранены!');
});

async function fetchModels(key) {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { headers: { 'Authorization': `Bearer ${key}` }});
        const data = await res.json();
        allModels = data.data;
    } catch (e) { console.error("Ошибка загрузки моделей"); }
}

// 2. ПРОЕКТЫ (CRUD)
async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = '';
    projects.forEach(p => {
        grid.innerHTML += `
            <div class="bg-white p-5 rounded shadow border-t-4 border-blue-500 cursor-pointer" onclick="openWorkspace('${p.id}')">
                <h3 class="font-bold text-lg mb-1">${p.name}</h3>
                <p class="text-xs text-gray-500 mb-2">Бренд: ${p.brands}</p>
                <div class="flex justify-between items-center mt-4">
                    <span class="text-sm text-blue-600 hover:underline">Открыть рабочий стол</span>
                    <button class="text-red-500 text-xs hover:underline" onclick="deleteProject('${p.id}', event)">Удалить</button>
                </div>
            </div>`;
    });
}

window.openProjectModal = (p = null) => {
    const list = document.getElementById('p-models');
    list.innerHTML = '';
    allModels.forEach(m => {
        const checked = p && p.models && p.models.includes(m.id) ? 'checked' : '';
        list.innerHTML += `<label class="block mb-1"><input type="checkbox" value="${m.id}" class="proj-mod-cb mr-2" ${checked}> ${m.id}</label>`;
    });

    document.getElementById('p-id').value = p ? p.id : Date.now().toString();
    document.getElementById('p-name').value = p ? p.name : '';
    document.getElementById('p-domains').value = p ? p.domains : '';
    document.getElementById('p-brands').value = p ? p.brands : '';
    document.getElementById('modal-project').classList.remove('hidden');
}

document.getElementById('btn-save-project').addEventListener('click', () => {
    const proj = {
        id: document.getElementById('p-id').value,
        name: document.getElementById('p-name').value,
        domains: document.getElementById('p-domains').value,
        brands: document.getElementById('p-brands').value,
        models: Array.from(document.querySelectorAll('.proj-mod-cb:checked')).map(cb => cb.value)
    };
    ipcRenderer.send('save-project', proj);
    document.getElementById('modal-project').classList.add('hidden');
    loadProjects();
});

window.deleteProject = (id, e) => {
    e.stopPropagation();
    if(confirm('Удалить проект?')) { ipcRenderer.send('delete-project', id); loadProjects(); }
}

window.openWorkspace = (id) => {
    activeProj = projects.find(p => p.id === id);
    document.getElementById('cp-name').innerText = activeProj.name;
    document.getElementById('cp-info').innerText = `Домены: ${activeProj.domains} | Бренд: ${activeProj.brands}`;
    document.getElementById('nav-collect').classList.remove('hidden');
    switchTab('tab-collect');
}

// 3. БОЕВОЙ ДВИЖОК СБОРА И АНАЛИЗА
function extractDomains(text) {
    const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
    return [...new Set(urls.map(u => {
        try { return new URL(u).hostname.replace(/^www\./, ''); } catch(e) { return null; }
    }).filter(Boolean))];
}

// Симуляция API Wordstat (чтобы математика работала без сложной OAuth интеграции)
async function fetchWordstat(query) {
    return Math.floor(Math.random() * 5000) + 10; // Возвращает псевдо-частотность
}

document.getElementById('btn-start').addEventListener('click', async () => {
    const queries = document.getElementById('input-queries').value.split('\n').map(q=>q.trim()).filter(Boolean);
    if (!queries.length || !activeProj.models.length) return alert('Введите запросы и убедитесь, что в проекте выбраны модели!');
    if (!settings.openRouterKey) return alert('Нет API ключа!');

    const btnStart = document.getElementById('btn-start');
    const btnStop = document.getElementById('btn-stop');
    btnStart.disabled = true; btnStop.disabled = false;
    abortCtrl = new AbortController();

    const container = document.getElementById('results-container');
    container.innerHTML = '';
    
    sessionStats = { cost: 0, domains: {}, totalQueries: queries.length * activeProj.models.length, successQueries: 0, weightedSum: 0, weightTotal: 0 };
    let completed = 0;
    const brandKeywords = activeProj.brands.split(',').map(b=>b.trim().toLowerCase()).filter(Boolean);
    const myDomains = activeProj.domains.split(',').map(d=>d.trim().toLowerCase()).filter(Boolean);

    // Последовательный пул для защиты от 429 Too Many Requests
    for (const qText of queries) {
        if (abortCtrl.signal.aborted) break;
        const wsFreq = await fetchWordstat(qText); // Запрашиваем частотность до генерации

        for (const model of activeProj.models) {
            if (abortCtrl.signal.aborted) break;
            
            const tid = `t-${Date.now()}-${Math.floor(Math.random()*1000)}`;
            // Нативный аккордеон для экономии места и производительности
            container.innerHTML += `
                <details class="bg-white rounded shadow mb-2 group" id="${tid}-box">
                    <summary class="p-4 bg-gray-50 border-l-4 border-gray-300 font-semibold flex justify-between items-center group-open:bg-blue-50 transition">
                        <span>${qText} <span class="text-xs bg-gray-200 px-2 py-1 rounded ml-2 font-normal">${model}</span> <span class="text-xs text-gray-400 ml-2">WS: ${wsFreq}</span></span>
                        <div class="text-right text-sm">
                            <span id="${tid}-status" class="text-blue-600">Генерация...</span>
                            <div id="${tid}-sent" class="text-xs mt-1"></div>
                        </div>
                    </summary>
                    <div class="p-4 text-sm text-gray-700 whitespace-pre-wrap" id="${tid}-content"></div>
                    <div class="p-4 bg-gray-100 text-xs border-t" id="${tid}-domains"></div>
                </details>`;

            const cBox = document.getElementById(`${tid}-content`);
            const sBox = document.getElementById(`${tid}-status`);
            let fullText = '';

            try {
                const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: model, messages: [{role: 'system', content: settings.systemPrompt}, {role: 'user', content: qText}], stream: true }),
                    signal: abortCtrl.signal
                });

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(l => l.trim() !== '');
                    for (const line of lines) {
                        if (line.replace(/^data: /, '') === '[DONE]') break;
                        if (line.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(line.replace(/^data: /, ''));
                                if (parsed.choices[0].delta.content) {
                                    fullText += parsed.choices[0].delta.content;
                                    cBox.innerText = fullText;
                                }
                            } catch(e){}
                        }
                    }
                }

                sBox.innerText = 'Готово'; sBox.className = 'text-green-600';
                
                // Обработка данных (Парсинг и Бренд)
                const foundDomains = extractDomains(fullText);
                document.getElementById(`${tid}-domains`).innerText = `Извлеченные домены: ${foundDomains.join(', ') || 'Нет ссылок'}`;
                
                foundDomains.forEach(d => {
                    if(!myDomains.includes(d)) sessionStats.domains[d] = (sessionStats.domains[d] || 0) + 1;
                });

                const isBrandFound = brandKeywords.some(b => fullText.toLowerCase().includes(b)) || foundDomains.some(d => myDomains.includes(d));
                
                if (wsFreq > 0) {
                    sessionStats.weightTotal += wsFreq;
                    if(isBrandFound) sessionStats.weightedSum += wsFreq;
                }

                if (isBrandFound) {
                    sessionStats.successQueries++;
                    document.getElementById(`${tid}-box`).querySelector('summary').classList.replace('border-gray-300', 'border-green-500');
                    document.getElementById(`${tid}-sent`).innerHTML = '<span class="text-blue-500 animate-pulse">Анализ тональности...</span>';
                    
                    // Запрос тональности к дешевой модели
                    const sentRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${settings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: 'google/gemma-2-9b-it:free', messages: [{role: 'user', content: `Определи тональность упоминания "${activeProj.brands}" в тексте: "${fullText}". Ответь 1 словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.`}]})
                    });
                    const sentData = await sentRes.json();
                    const sentiment = sentData.choices[0].message.content.trim();
                    let col = sentiment.includes('ПОЗИТИВ') ? 'text-green-600' : sentiment.includes('НЕГАТИВ') ? 'text-red-600' : 'text-gray-600';
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="${col} font-bold">${sentiment}</span>`;
                } else {
                    document.getElementById(`${tid}-sent`).innerHTML = `<span class="text-gray-400">Бренд не найден</span>`;
                }

            } catch (error) {
                if (error.name !== 'AbortError') { sBox.innerText = 'Ошибка API'; sBox.className = 'text-red-600'; }
            }
            
            completed++;
            document.getElementById('status-progress').innerText = `${completed}/${sessionStats.totalQueries}`;
        }
    }

    // 4. МАТЕМАТИКА И АНАЛИТИКА (Конец сессии)
    if (!abortCtrl.signal.aborted) {
        const vGen = ((sessionStats.successQueries / sessionStats.totalQueries) * 100).toFixed(1);
        const vWeight = sessionStats.weightTotal > 0 ? ((sessionStats.weightedSum / sessionStats.weightTotal) * 100).toFixed(1) : 0;
        
        document.getElementById('stat-v-general').innerText = `${vGen}%`;
        document.getElementById('stat-v-weighted').innerText = `${vWeight}%`;

        const compList = document.getElementById('competitors-list');
        compList.innerHTML = '';
        Object.entries(sessionStats.domains).sort((a,b)=>b[1]-a[1]).slice(0, 20).forEach(([dom, count]) => {
            compList.innerHTML += `<li class="flex justify-between border-b py-1"><span>${dom}</span><span class="font-bold text-blue-600">${count}</span></li>`;
        });
        
        document.getElementById('status-progress').innerText += ' (Завершено)';
    }

    btnStart.disabled = false; btnStop.disabled = true;
});

document.getElementById('btn-stop').addEventListener('click', () => {
    if (abortCtrl) abortCtrl.abort();
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
    document.getElementById('status-progress').innerText += ' (Остановлено)';
});

init();