// GameServerLogic.js (ИСПРАВЛЕННЫЙ КОД)

// --- Утилиты Карт ---
const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S'];

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

class Table {
    constructor(id, options, creatorId) { 
        this.id = id;
        this.creatorId = creatorId; // NEW: Храним ID создателя
        this.gameType = options.gameType || 'Blackjack';
        this.maxPlayers = options.maxPlayers || 6;
        this.minPlayers = 2; // FIX: Минимум 2 игрока
        this.minBet = options.minBet || 10;
        this.isPrivate = options.isPrivate || false;
        this.players = {};
        this.dealerHand = [];
        this.state = 'WAITING_FOR_PLAYERS';
        this.deck = new Deck();
        this.roundId = 0; 
    }
    
    addPlayer(player) {
        if (Object.keys(this.players).length >= this.maxPlayers) return false;
        
        this.players[player.id] = { 
            id: player.id,
            username: player.username,
            bet: 0, 
            hand: [],
            active: false,
            stood: false,
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

    placeBet(playerId, amount) {
        const player = this.players[playerId];
        if (this.state !== 'BETTING_ROUND' || !player || amount < this.minBet) return false;

        player.bet = amount;
        player.active = true;
        
        // В реальной игре нужно обновить баланс игрока в GameServerLogic!
        
        this.sendTableState(this);
        
        return true;
    }
}

// --- ОСНОВНОЙ КЛАСС СЕРВЕРА ---

class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.tables = {}; 
        this.players = {}; 
        this.tableCounter = 1;
        
        this.startTableLoop();

        // Создание тестового стола (T1)
        this.createTable({ id: 'System' }, { maxPlayers: 4, minBet: 10, gameType: 'Blackjack', isPrivate: false });
    }

    // --- АУТЕНТИФИКАЦИЯ И УПРАВЛЕНИЕ ЛОББИ ---

    handleAuth(socket) {
        let player = this.players[socket.id];
        
        if (!player) {
            player = {
                id: socket.id,
                username: `User-${Math.floor(Math.random() * 9000) + 1000}`,
                balance: 5000, 
                currentTableId: null,
                socket: socket,
            };
            this.players[socket.id] = player;
            console.log(`New player registered: ${player.username} (${socket.id})`);
        }
        
        socket.emit('auth_success', { 
            id: player.id,
            username: player.username,
            balance: player.balance
        });

        this.broadcastTableList(socket);
    }
    
    // ИСПРАВЛЕН: Теперь передает minPlayers и creatorId
    broadcastTableList(targetSocket = null) {
        const tablesList = Object.values(this.tables).map(table => ({
            id: table.id,
            gameType: table.gameType,
            minBet: table.minBet,
            currentPlayers: Object.values(table.players).length,
            maxPlayers: table.maxPlayers,
            minPlayers: table.minPlayers, // NEW
            creatorId: table.creatorId, // NEW
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
    
    // ИСПРАВЛЕН: Добавляет creatorId
    createTable(socket, options) {
        const player = this.players[socket.id];
        const creatorId = socket.id === 'System' ? 'System' : player?.id;
        
        if (!creatorId) return socket?.emit('error_message', 'Ошибка: Вы не авторизованы.');

        options.maxPlayers = options.maxPlayers || 6;
        
        const tableId = `T${this.tableCounter++}`;
        const newTable = new Table(tableId, options, creatorId); // Передаем creatorId
        this.tables[tableId] = newTable;
        
        console.log(`Table created: ${tableId} (${newTable.gameType}) by ${creatorId}`);

        if (creatorId !== 'System') {
            this.joinTable(socket, tableId);
        }
        
        this.broadcastTableList();
    }
    
    // NEW: Метод для ручного старта игры
    startGame(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!player || !table) {
            return socket.emit('error_message', 'Стол не найден.');
        }

        // 1. Проверка создателя
        if (player.id !== table.creatorId) {
            return socket.emit('error_message', 'Только создатель стола может начать игру.');
        }
        
        // 2. Проверка состояния и игроков
        const playerCount = Object.values(table.players).length;
        if (table.state !== 'WAITING_FOR_PLAYERS') {
            return socket.emit('error_message', 'Игра уже идет.');
        }
        if (playerCount < table.minPlayers) {
            return socket.emit('error_message', `Для начала игры нужно минимум ${table.minPlayers} игрока.`);
        }
        
        // 3. Запуск игры (начинаем раунд ставок)
        this.startBlackjackRound(table);
        this.broadcastTableList(); 
    }
    
    // NEW: Начало раунда Блэкджека (переход в состояние ставок)
    startBlackjackRound(table) {
        if (table.state !== 'WAITING_FOR_PLAYERS') return;

        table.state = 'BETTING_ROUND';
        table.roundId = Date.now(); 
        table.deck.reset(); // Перемешиваем колоду
        table.dealerHand = [];

        Object.values(table.players).forEach(p => {
            p.bet = 0;
            p.hand = [];
            p.active = true; // Игрок считается активным до тех пор, пока не покинет стол
            p.stood = false;
        });

        console.log(`Round started (BETTING) for table ${table.id}`);
        this.sendTableState(table); 
    }

    joinTable(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!player || !table) { return socket.emit('error_message', 'Ошибка при входе в комнату.'); }

        if (table.addPlayer(player)) {
            player.currentTableId = tableId;
            socket.join(tableId);
            
            this.io.to(tableId).emit('table_joined', { tableId: tableId });
            this.sendTableState(table);
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
            
            this.io.to(tableId).emit('player_left', { playerId: player.id });
            
            if (Object.values(table.players).length === 0 && table.id !== 'T1') {
                delete this.tables[tableId];
            } else if (table.creatorId === player.id) {
                // Если создатель ушел, назначаем первого игрока новым создателем
                const newCreatorId = Object.keys(table.players)[0] || 'System';
                table.creatorId = newCreatorId;
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

    placeBet(socket, tableId, amount) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table?.placeBet(player.id, amount)) {
            player.balance -= amount; // Снимаем деньги с баланса
            socket.emit('auth_success', { id: player.id, balance: player.balance }); // Обновляем баланс
            this.sendTableState(table); 
        } else {
            socket.emit('error_message', 'Не удалось принять ставку. Проверьте сумму и состояние стола.');
        }
    }
    
    hit(socket, tableId) {
        // ... (логика hit)
        socket.emit('error_message', 'Действие "Hit" пока не реализовано.');
    }

    stand(socket, tableId) {
        // ... (логика stand)
        socket.emit('error_message', 'Действие "Stand" пока не реализовано.');
    }
    
    sendTableState(table) {
        const tableState = {
            id: table.id,
            state: table.state,
            creatorId: table.creatorId, 
            minPlayers: table.minPlayers, 
            dealerHand: table.dealerHand,
            dealerScore: calculateScore(table.dealerHand),
            players: Object.values(table.players).map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                active: p.active,
                stood: p.stood,
            }))
        };
        this.io.to(table.id).emit('table_state', tableState);
    }

    startTableLoop() {
        setInterval(() => {
            // В этом цикле может быть логика для автоматического продвижения игры
        }, 1000); 
    }
}

module.exports = { GameServerLogic, Table, calculateScore, Deck };