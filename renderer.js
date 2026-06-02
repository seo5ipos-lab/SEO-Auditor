const { ipcRenderer } = require('electron');

let currentSettings = {};
let projects = [];
let activeProject = null;
let availableModels = [];
let abortController = null;

// Загрузка при старте
async function init() {
    currentSettings = await ipcRenderer.invoke('get-settings');
    if (currentSettings && currentSettings.openRouterKey) {
        document.getElementById('setting-openrouter').value = currentSettings.openRouterKey;
        await fetchModels(currentSettings.openRouterKey);
    }
    loadProjects();
}

// Загрузка списка моделей
async function fetchModels(apiKey) {
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const data = await response.json();
        availableModels = data.data;
    } catch (error) {
        console.error("Ошибка загрузки моделей");
    }
}

// Отрисовка списка проектов
async function loadProjects() {
    projects = await ipcRenderer.invoke('get-projects');
    const grid = document.getElementById('projects-grid');
    grid.innerHTML = '';
    
    projects.forEach(p => {
        const card = document.createElement('div');
        card.className = 'bg-white p-5 rounded shadow hover:shadow-md transition cursor-pointer border-t-4 border-blue-500';
        card.innerHTML = `
            <h3 class="font-bold text-lg mb-1">${p.name}</h3>
            <p class="text-xs text-gray-500 mb-4">Бренд: ${p.brands}</p>
            <div class="flex justify-between items-center">
                <button class="text-blue-600 text-sm hover:underline" onclick="openProject('${p.id}')">Открыть</button>
                <button class="text-red-500 text-xs hover:underline" onclick="deleteProject('${p.id}', event)">Удалить</button>
            </div>
        `;
        grid.appendChild(card);
    });
}

// Создание/Редактирование проекта
document.getElementById('btn-create-project').addEventListener('click', () => openModal());
document.getElementById('btn-edit-project').addEventListener('click', () => openModal(activeProject));

function openModal(project = null) {
    const list = document.getElementById('models-list');
    list.innerHTML = '';
    availableModels.forEach(m => {
        const checked = project && project.models && project.models.includes(m.id) ? 'checked' : '';
        list.innerHTML += `<label class="block mb-1"><input type="checkbox" value="${m.id}" class="proj-model-cb mr-2" ${checked}> ${m.id}</label>`;
    });

    if (project) {
        document.getElementById('proj-id').value = project.id;
        document.getElementById('proj-name').value = project.name;
        document.getElementById('proj-domains').value = project.domains;
        document.getElementById('proj-brands').value = project.brands;
        document.getElementById('modal-title').innerText = 'Редактировать проект';
    } else {
        document.getElementById('proj-id').value = Date.now().toString();
        document.getElementById('proj-name').value = '';
        document.getElementById('proj-domains').value = '';
        document.getElementById('proj-brands').value = '';
        document.getElementById('modal-title').innerText = 'Новый проект';
    }
    document.getElementById('project-modal').classList.remove('hidden');
}

document.getElementById('btn-save-project').addEventListener('click', () => {
    const selectedModels = Array.from(document.querySelectorAll('.proj-model-cb:checked')).map(cb => cb.value);
    const newProj = {
        id: document.getElementById('proj-id').value,
        name: document.getElementById('proj-name').value,
        domains: document.getElementById('proj-domains').value,
        brands: document.getElementById('proj-brands').value,
        models: selectedModels
    };
    ipcRenderer.send('save-project', newProj);
    closeModal();
    loadProjects();
});

window.deleteProject = (id, event) => {
    event.stopPropagation();
    if(confirm('Удалить проект?')) {
        ipcRenderer.send('delete-project', id);
        loadProjects();
    }
}

// Открытие рабочего стола проекта
window.openProject = (id) => {
    activeProject = projects.find(p => p.id === id);
    document.getElementById('current-project-name').innerText = activeProject.name;
    document.getElementById('current-project-info').innerText = `Домены: ${activeProject.domains} | Бренд: ${activeProject.brands}`;
    document.getElementById('nav-collect').classList.remove('hidden');
    
    // Переключаемся на вкладку "Рабочий стол"
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.getElementById('tab-collect').classList.add('active');
    document.getElementById('results-container').innerHTML = ''; // Очищаем старые результаты
}

// --- БОЕВАЯ ЛОГИКА И АНАЛИЗ ТОНАЛЬНОСТИ ---
document.getElementById('btn-start').addEventListener('click', async () => {
    const queries = document.getElementById('input-queries').value.split('\n').filter(q => q.trim() !== '');
    if (queries.length === 0 || !activeProject || activeProject.models.length === 0) return alert('Проверьте запросы и настройки проекта!');

    document.getElementById('btn-start').disabled = true;
    document.getElementById('btn-stop').disabled = false;
    abortController = new AbortController();

    const totalTasks = queries.length * activeProject.models.length;
    let completedTasks = 0;
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '';

    // Подготавливаем слова бренда для поиска
    const brandKeywords = activeProject.brands.split(',').map(b => b.trim().toLowerCase()).filter(b => b !== '');

    for (const query of queries) {
        for (const model of activeProject.models) {
            if (abortController.signal.aborted) break;

            const taskId = `task-${Date.now()}`;
            const resultBlock = document.createElement('div');
            resultBlock.className = 'bg-white p-4 rounded shadow border-l-4 border-gray-300 mb-4';
            resultBlock.innerHTML = `
                <div class="flex justify-between items-center mb-2">
                    <h3 class="font-bold">${query} <span class="bg-gray-200 text-xs px-2 py-1 rounded ml-2">${model}</span></h3>
                    <div class="text-right">
                        <span id="${taskId}-status" class="text-sm text-blue-600">Генерация...</span>
                        <div id="${taskId}-sentiment" class="text-xs font-bold mt-1"></div>
                    </div>
                </div>
                <div id="${taskId}-content" class="text-gray-700 text-sm bg-gray-50 p-3 rounded"></div>
            `;
            resultsContainer.appendChild(resultBlock);

            const contentBox = document.getElementById(`${taskId}-content`);
            let fullText = '';

            try {
                const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${currentSettings.openRouterKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: query }],
                        stream: true
                    }),
                    signal: abortController.signal
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder("utf-8");

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n').filter(line => line.trim() !== '');
                    for (const line of lines) {
                        if (line.replace(/^data: /, '') === '[DONE]') break;
                        if (line.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(line.replace(/^data: /, ''));
                                if (parsed.choices[0].delta.content) {
                                    fullText += parsed.choices[0].delta.content;
                                    contentBox.innerText = fullText;
                                }
                            } catch (e) {}
                        }
                    }
                }
                document.getElementById(`${taskId}-status`).innerText = 'Готово';
                document.getElementById(`${taskId}-status`).className = 'text-sm text-green-600';

                // --- АНАЛИЗ ТОНАЛЬНОСТИ ---
                const textLower = fullText.toLowerCase();
                const isBrandFound = brandKeywords.some(keyword => textLower.includes(keyword));

                if (isBrandFound) {
                    resultBlock.classList.replace('border-gray-300', 'border-green-500');
                    document.getElementById(`${taskId}-sentiment`).innerHTML = '<span class="text-blue-500 animate-pulse">Анализ тональности...</span>';
                    
                    // Запрос к дешевой модели для оценки тональности
                    const sentimentResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${currentSettings.openRouterKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'google/gemma-2-9b-it:free', // Бесплатная быстрая модель на OpenRouter
                            messages: [{ 
                                role: 'user', 
                                content: `Определи тональность упоминания компании "${activeProject.brands}" в тексте: "${fullText}". Ответь строго одним словом: ПОЗИТИВНАЯ, НЕГАТИВНАЯ или НЕЙТРАЛЬНАЯ.` 
                            }]
                        })
                    });
                    
                    const sentimentData = await sentimentResponse.json();
                    const sentimentResult = sentimentData.choices[0].message.content.trim();
                    
                    let color = 'text-gray-600';
                    if(sentimentResult.includes('ПОЗИТИВ')) color = 'text-green-600';
                    if(sentimentResult.includes('НЕГАТИВ')) color = 'text-red-600';
                    
                    document.getElementById(`${taskId}-sentiment`).innerHTML = `<span class="${color}">Тональность: ${sentimentResult}</span>`;
                } else {
                    document.getElementById(`${taskId}-sentiment`).innerHTML = `<span class="text-gray-400">Бренд не найден</span>`;
                }

            } catch (error) {
                if (error.name !== 'AbortError') {
                    document.getElementById(`${taskId}-status`).innerText = 'Ошибка';
                }
            }
            completedTasks++;
            document.getElementById('status-progress').innerText = `${completedTasks}/${totalTasks}`;
        }
    }
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
});

document.getElementById('btn-stop').addEventListener('click', () => {
    if (abortController) abortController.abort();
    document.getElementById('btn-start').disabled = false;
    document.getElementById('btn-stop').disabled = true;
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
    currentSettings.openRouterKey = document.getElementById('setting-openrouter').value;
    ipcRenderer.send('save-settings', currentSettings);
    alert('Сохранено!');
    init();
});

init();
