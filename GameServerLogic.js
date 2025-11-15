// GameServerLogic.js (ИСПРАВЛЕННЫЙ КОД)

// --- УТИЛИТЫ КАРТ ---

const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S']; // Clubs, Diamonds, Hearts, Spades

function calculateScore(hand) {
    let score = 0;
    let aces = 0;
    hand.forEach(cardStr => {
        const rank = cardStr.slice(0, -1);
        if (rank === 'A') {
            aces++;
            score += 11;
        } else if (['K', 'Q', 'J', 'T'].includes(rank)) {
            score += 10;
        } else {
            score += parseInt(rank);
        }
    });
    while (score > 21 && aces > 0) {
        score -= 10;
        aces--;
    }
    return score;
}

class Deck {
    constructor() {
        this.cards = [];
        this.reset();
    }
    reset() {
        this.cards = [];
        for (const suit of cardSuits) {
            for (const rank of cardRanks) {
                this.cards.push(rank + suit);
            }
        }
        this.shuffle();
    }
    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }
    draw() {
        return this.cards.pop();
    }
}
// ----------------------

// --- БАЗОВАЯ ЛОГИКА СТОЛА (Table) ---
// Этот класс необходим для работы методов createTable/joinTable в GameServerLogic.

class Table {
    constructor(id, options) {
        this.id = id;
        this.gameType = options.gameType || 'Blackjack'; 
        this.maxPlayers = options.maxPlayers || 4;
        this.minBet = options.minBet || 10;
        this.isPrivate = options.isPrivate || false;
        this.password = options.password || null;
        this.players = {}; // { playerId: { ...player_data } }
        this.dealerHand = []; // Используется в Блэкджеке
        this.state = 'WAITING_FOR_PLAYERS';
        this.deck = new Deck();
    }
    
    addPlayer(player) {
        if (Object.keys(this.players).length >= this.maxPlayers) return false;
        
        // Создаем упрощенную копию объекта игрока для стола
        this.players[player.id] = { 
            id: player.id,
            username: player.username,
            bet: 0, 
            hand: [],
            active: false
        };
        return true;
    }

    removePlayer(playerId) {
        if (this.players[playerId]) {
            delete this.players[playerId];
            return true;
        }
        return false;
    }
    
    // ... Дополнительные методы для игры (placeBet, handleHit, handleStand)
    // должны быть реализованы здесь, но опущены для фокуса на исправлении ошибки.
}

// --- ОСНОВНОЙ КЛАСС СЕРВЕРА ---

class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.tables = {}; 
        this.players = {}; 
        this.tableCounter = 1;
        
        this.startTableLoop();

        // Создание тестового стола при запуске (как в вашем логе)
        this.createTable(null, { maxPlayers: 4, minBet: 10, gameType: 'Blackjack', isPrivate: false });
    }

    // --- АУТЕНТИФИКАЦИЯ И УПРАВЛЕНИЕ ЛОББИ (ИСПРАВЛЕНИЕ ОШИБКИ) ---

    /**
     * Обрабатывает запрос авторизации от нового клиента.
     * Создает профиль, если его нет, и отправляет данные игрока и список столов.
     * @param {Socket} socket 
     */
    handleAuth(socket) {
        let player = this.players[socket.id];
        
        // 1. Создание профиля игрока (простая авторизация)
        if (!player) {
            player = {
                id: socket.id,
                username: `User-${Math.floor(Math.random() * 9000) + 1000}`,
                balance: 5000, // Начальный баланс
                currentTableId: null,
                socket: socket,
            };
            this.players[socket.id] = player;
            console.log(`New player registered: ${player.username} (${socket.id})`);
        }
        
        // 2. Отправляем клиенту его ID, имя и баланс (auth_success)
        socket.emit('auth_success', { 
            id: player.id,
            username: player.username,
            balance: player.balance
        });

        // 3. Отправляем клиенту список доступных столов (table_list)
        this.broadcastTableList(socket);
    }
    
    /**
     * Формирует и рассылает список доступных столов.
     * @param {Socket} targetSocket - Если указан, отправляется только этому сокету.
     */
    broadcastTableList(targetSocket = null) {
        const tablesList = Object.values(this.tables).map(table => ({
            id: table.id,
            gameType: table.gameType,
            minBet: table.minBet,
            currentPlayers: Object.values(table.players).length,
            maxPlayers: table.maxPlayers,
            isPrivate: table.isPrivate,
            state: table.state
        }));

        if (targetSocket) {
             targetSocket.emit('table_list', tablesList);
        } else {
             this.io.emit('table_list', tablesList);
        }
        return tablesList;
    }
    
    // --- УПРАВЛЕНИЕ СТОЛАМИ И СОЕДИНЕНИЯМИ ---

    createTable(socket, options) {
        const tableId = `T${this.tableCounter++}`;
        const newTable = new Table(tableId, options);
        this.tables[tableId] = newTable;
        
        if (socket) {
            this.joinTable(socket, tableId);
        }
        
        this.broadcastTableList();
    }
    
    joinTable(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!player || !table) { /* ... обработка ошибок ... */ return; }

        if (table.addPlayer(player)) {
            player.currentTableId = tableId;
            socket.join(tableId);
            
            // ... Логика отправки состояния стола
            this.broadcastTableList();
        } else {
            socket.emit('error_message', 'Ошибка: Стол полон.');
        }
    }

    leaveTable(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;

        const tableId = player.currentTableId;
        const table = this.tables[tableId];
        
        if (table) {
            table.removePlayer(player.id);
            socket.leave(tableId);
            player.currentTableId = null;
            
            // ... Логика уведомления игроков
            
            if (Object.values(table.players).length === 0 && table.id !== 'T1') {
                delete this.tables[tableId];
            }
        }
        
        socket.emit('return_to_lobby', { tables: this.broadcastTableList() });
        this.broadcastTableList(); 
    }

    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player) {
            if (player.currentTableId) {
                this.leaveTable(socket); 
            }
            delete this.players[socket.id];
            this.broadcastTableList(); 
        }
    }

    // --- ЛОГИКА ИГР (ЗАГЛУШКИ) ---
    placeBet(socket, tableId, amount) {
        socket.emit('error_message', 'Метод placeBet не реализован в этой версии.');
    }
    hit(socket, tableId) {
        socket.emit('error_message', 'Метод hit не реализован в этой версии.');
    }
    stand(socket, tableId) {
        socket.emit('error_message', 'Метод stand не реализован в этой версии.');
    }
    // ... и остальные методы (pokerAction и т.д.)

    // --- ПАКЕТНЫЙ ЦИКЛ ОБНОВЛЕНИЯ (GAME LOOP) ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                // Здесь должна быть логика для смены состояния
                // Например: старт раунда, ход ботов и т.д.
            });
        }, 1000); 
    }
    
    sendTableState(table) {
        // ... Логика отправки состояния стола
    }
}

// Экспорт класса, чтобы его можно было использовать в server.js
module.exports = { GameServerLogic, Table, calculateScore, Deck };