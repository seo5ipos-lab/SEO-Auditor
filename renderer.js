const { ipcRenderer } = require('electron');

// Элементы UI
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsStatus = document.getElementById('settings-status');
const openrouterKeyInput = document.getElementById('setting-openrouter');
const wordstatKeyInput = document.getElementById('setting-wordstat');
const promptInput = document.getElementById('setting-prompt');
const modelsList = document.getElementById('models-list');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');

let currentSettings = {};
let abortController = null; // Для остановки процессов

// 1. Загрузка настроек при старте
async function loadSettings() {
    currentSettings = await ipcRenderer.invoke('get-settings');
    if (currentSettings) {
        openrouterKeyInput.value = currentSettings.openRouterKey || '';
        wordstatKeyInput.value = currentSettings.wordstatKey || '';
        promptInput.value = currentSettings.systemPrompt || '';
        
        if (currentSettings.openRouterKey) {
            fetchModels(currentSettings.openRouterKey);
        }
    }
}

// 2. Сохранение настроек
btnSaveSettings.addEventListener('click', () => {
    currentSettings = {
        openRouterKey: openrouterKeyInput.value.trim(),
        endpoint: 'https://openrouter.ai/api/v1',
        wordstatKey: wordstatKeyInput.value.trim(),
        systemPrompt: promptInput.value.trim()
    };
    ipcRenderer.send('save-settings', currentSettings);
    
    settingsStatus.classList.remove('hidden');
    setTimeout(() => settingsStatus.classList.add('hidden'), 3000);
    
    if (currentSettings.openRouterKey) fetchModels(currentSettings.openRouterKey);
});

// 3. Загрузка списка моделей из OpenRouter
async function fetchModels(apiKey) {
    modelsList.innerHTML = '<p class="text-gray-500 text-sm">Загрузка моделей...</p>';
    try {
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        const data = await response.json();
        
        modelsList.innerHTML = ''; // Очищаем список
        data.data.forEach(model => {
            const label = document.createElement('label');
            label.className = 'block mb-1 text-sm';
            label.innerHTML = `<input type="checkbox" value="${model.id}" class="mr-2 model-checkbox"> ${model.id}`;
            modelsList.appendChild(label);
        });
    } catch (error) {
        modelsList.innerHTML = '<p class="text-red-500 text-sm">Ошибка загрузки моделей. Проверьте API ключ.</p>';
    }
}

// 4. Подготовка к сбору данных (с механизмом прерывания)
btnStart.addEventListener('click', () => {
    const queries = document.getElementById('input-queries').value.split('\n').filter(q => q.trim() !== '');
    if (queries.length === 0) return alert('Введите хотя бы один запрос!');
    
    btnStart.disabled = true;
    btnStop.disabled = false;
    abortController = new AbortController(); // Создаем контроллер для отмены
    
    document.getElementById('status-progress').innerText = `В очереди: ${queries.length}`;
    // Позже мы добавим сюда потоковые запросы (SSE), лингвистический анализ и калькуляцию стоимости
});

btnStop.addEventListener('click', () => {
    if (abortController) {
        abortController.abort(); // Прерываем запросы
        document.getElementById('status-progress').innerText += ' (Остановлено)';
    }
    btnStart.disabled = false;
    btnStop.disabled = true;
});

// Инициализируем приложение
loadSettings();