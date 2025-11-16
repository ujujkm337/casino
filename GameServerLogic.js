// GameServerLogic.js (Полный код с ИЗМЕНЕНИЯМИ)

const { v4: uuidv4 } = require('uuid');

// --- УТИЛИТЫ КАРТ (без изменений) ---
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
    constructor() { this.cards = []; this.reset(); }
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
        if (this.cards.length === 0) this.reset();
        return this.cards.pop();
    }
}
// --- Конец УТИЛИТ ---


class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.players = {};
        this.tables = {
            'T1': { id: 'T1', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 2, minBet: 10, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'T2': { id: 'T2', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 6, minBet: 20, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'P1': { id: 'P1', gameType: 'Poker', currentPlayers: 0, maxPlayers: 4, minBet: 50, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [], communityCards: [], pot: 0, currentBet: 0 } // Добавил поля Покера
        };
        
        this.quickPlayPool = {
            'Blackjack': [],
            'Poker': []
        };

        this.startTableLoop();
        this.startMatchmakingLoop();
    }
    
    // --- УПРАВЛЕНИЕ ЛОББИ И ПОЛЬЗОВАТЕЛЯМИ (без изменений) ---
    
    handleAuth(socket) {
        let player = this.players[socket.id];
        if (!player) {
            player = {
                id: socket.id,
                username: `User_${Math.floor(Math.random() * 10000)}`,
                balance: 10000,
                currentTableId: null
            };
            this.players[socket.id] = player;
        }
        socket.emit('auth_success', { id: player.id, username: player.username, balance: player.balance, tables: this.broadcastTableList() });
        this.broadcastTableList();
    }

    broadcastTableList() {
        const publicTables = Object.values(this.tables).map(table => ({
            id: table.id,
            gameType: table.gameType,
            currentPlayers: table.players.length,
            maxPlayers: table.maxPlayers,
            minBet: table.minBet,
            isPrivate: table.isPrivate,
            state: table.state
        }));
        this.io.emit('table_list', publicTables);
        return publicTables;
    }

    createTable(socket, data) {
        const player = this.players[socket.id];
        if (player.currentTableId) {
            socket.emit('error_message', 'Вы уже за столом.');
            return;
        }

        const newTableId = `T${uuidv4().slice(0, 4)}`;
        const newTable = {
            id: newTableId,
            gameType: data.gameType,
            currentPlayers: 0,
            maxPlayers: data.maxPlayers,
            minBet: data.minBet,
            isPrivate: data.isPrivate,
            password: data.password || null,
            state: 'WAITING_FOR_PLAYERS',
            players: [],
            deck: new Deck(),
            dealerHand: [] // Для Блэкджека
        };
        
        if (data.gameType === 'Poker') {
            newTable.communityCards = [];
            newTable.pot = 0;
            newTable.currentBet = 0;
        }
        
        this.tables[newTableId] = newTable;
        this.joinTable(socket, newTableId, false, null, true); 
    }

    // ИЗМЕНЕНО: Добавлена логика для Покера (state)
    joinTable(socket, tableId, wantsBots, password, isCreator = false) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!table) {
            socket.emit('error_message', 'Стол не найден.');
            return;
        }
        if (!isCreator && table.isPrivate && table.password && table.password !== password) {
             socket.emit('error_message', 'Неверный пароль.');
             return;
        }
        if (table.players.length >= table.maxPlayers) {
            socket.emit('error_message', 'Стол полон.');
            return;
        }
        if (player.currentTableId) {
             this.leaveTable(socket);
        }

        // В Покере до-определяем поля
        const playerState = { id: player.id, username: player.username, bet: 0, hand: [], active: true };
        if (table.gameType === 'Poker') {
             playerState.isFolded = false;
             playerState.totalBet = 0;
             playerState.currentBet = 0;
        }
        
        table.players.push(playerState); 
        player.currentTableId = tableId;
        table.currentPlayers = table.players.length;

        // 1. Установка статуса стола (Блэкджек)
        if (table.gameType === 'Blackjack' && (table.state === 'WAITING_FOR_PLAYERS' || table.state === 'RESULTS')) {
             table.state = 'WAITING_FOR_BETS';
        }
        
        // 2. НОВОЕ: Установка статуса стола (Покер)
        if (table.gameType === 'Poker' && table.state === 'WAITING_FOR_PLAYERS' && table.players.length >= 2) {
             table.state = 'READY_TO_START_POKER';
        }
        
        socket.join(tableId);
        socket.emit('table_joined', { tableId: tableId, gameType: table.gameType, minBet: table.minBet });

        this.sendTableState(table);
        this.broadcastTableList();
    }

    // ИЗМЕНЕНО: Добавлена логика для Покера (state)
    leaveTable(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;

        const tableId = player.currentTableId;
        const table = this.tables[tableId];
        
        const exitingPlayer = table.players.find(p => p.id === player.id);
        if (exitingPlayer && exitingPlayer.bet > 0) { // Блэкджек
             player.balance += exitingPlayer.bet;
             socket.emit('auth_success', { id: player.id, balance: player.balance });
        }
        // (Тут должна быть логика возврата ставок Покера, но пока пропускаем)
        
        table.players = table.players.filter(p => p.id !== player.id);
        table.currentPlayers = table.players.length;

        socket.leave(tableId);
        player.currentTableId = null;
        
        // Обновляем состояние стола:
        if (table.players.length === 0) {
             table.state = 'WAITING_FOR_PLAYERS';
        } else if (table.gameType === 'Blackjack' && table.state === 'READY_TO_START') {
            const allBetsIn = table.players.every(p => p.bet > 0);
            if (!allBetsIn) table.state = 'WAITING_FOR_BETS';
        
        // НОВОЕ: Проверка Покера
        } else if (table.gameType === 'Poker' && (table.state === 'READY_TO_START_POKER' || table.state === 'PRE_FLOP')) {
             if (table.players.length < 2) {
                 table.state = 'WAITING_FOR_PLAYERS';
             }
        }
        
        this.sendTableState(table); 

        socket.emit('return_to_lobby', { tables: this.broadcastTableList() }); 
        this.broadcastTableList(); 
    }
    
    // --- ЛОГИКА БЛЭКДЖЕКА ---

    sendTableState(table) {
        // Базовое состояние
        const tableState = {
            id: table.id,
            state: table.state,
            players: [], // Будет заполнено ниже
        };

        // Специфичные поля для Блэкджека
        if (table.gameType === 'Blackjack') {
            tableState.dealerHand = table.dealerHand;
            tableState.dealerScore = calculateScore(table.dealerHand);
            tableState.activePlayerId = table.activePlayerIndex !== undefined && table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex]
                                       ? table.players[table.activePlayerIndex].id : null;
            
            tableState.players = table.players.map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                active: p.active
            }));
        }

        // Специфичные поля для Покера
        if (table.gameType === 'Poker') {
            tableState.communityCards = table.communityCards;
            tableState.pot = table.pot;
            tableState.currentBet = table.currentBet;
            tableState.activePlayerId = table.activePlayerIndex !== undefined && table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex]
                                       ? table.players[table.activePlayerIndex].id : null;

            tableState.players = table.players.map(p => ({
                id: p.id,
                username: p.username,
                hand: p.hand,
                active: p.active,
                isFolded: p.isFolded,
                totalBet: p.totalBet,
                currentBet: p.currentBet
            }));
        }

        this.io.to(table.id).emit('table_state', tableState);
    }
    
    placeBet(socket, tableId, amount) {
        // (Логика placeBet ... )
        const player = this.players[socket.id];
        const table = this.tables[tableId];
        if (!table || table.state !== 'WAITING_FOR_BETS' || table.gameType !== 'Blackjack') {
             socket.emit('error_message', 'Не время для ставок.'); return;
        }
        const tablePlayer = table.players.find(p => p.id === player.id);
        if (tablePlayer) {
             if (tablePlayer.bet > 0) {
                 socket.emit('error_message', 'Вы уже сделали ставку.'); return;
             }
            tablePlayer.bet = amount;
            player.balance -= amount;
            socket.emit('auth_success', { id: player.id, balance: player.balance });
            const allBetsIn = table.players.every(p => p.bet > 0);
            if (allBetsIn && table.players.length > 0) {
                table.state = 'READY_TO_START'; 
            }
             this.sendTableState(table);
        } else {
             socket.emit('error_message', 'Вы не за столом.');
        }
    }
    
    // ИЗМЕНЕНО: Обрабатывает и Блэкджек, и Покер
    startGameCommand(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!table) {
             socket.emit('error_message', 'Стол не найден.');
             return;
        }
        
        // Логика Блэкджека
        if (table.gameType === 'Blackjack') {
            if (table.state === 'READY_TO_START') {
                 this.startGame(table);
                 this.sendTableState(table); 
            } else if (table.state === 'WAITING_FOR_BETS') {
                 socket.emit('error_message', 'Ожидаем ставки от всех игроков.');
            } else {
                 socket.emit('error_message', 'Игра уже идет.');
            }
        }
        
        // НОВАЯ ЛОГИКА: Покер
        if (table.gameType === 'Poker') {
            if (table.state === 'READY_TO_START_POKER') {
                 this.startPokerGame(table); // Новая функция
                 this.sendTableState(table);
            } else {
                 socket.emit('error_message', 'Игра уже идет или ожидает игроков.');
            }
        }
    }
    
    // (Запуск Блэкджека)
    startGame(table) {
        if (table.gameType === 'Blackjack' && table.players.some(p => p.bet > 0)) {
            table.deck.reset(); 
            table.dealerHand = [];
            table.players.forEach(p => {
                p.hand = []; p.active = (p.bet > 0); 
            });
            for (let i = 0; i < 2; i++) {
                table.dealerHand.push(table.deck.draw());
                table.players.filter(p => p.active).forEach(p => {
                    p.hand.push(table.deck.draw());
                });
            }
            table.activePlayerIndex = table.players.findIndex(p => p.active);
            if (table.activePlayerIndex !== -1) {
                table.state = 'PLAYER_TURN'; 
            } else {
                 table.state = 'WAITING_FOR_BETS';
            }
        }
    }
    
    /**
     * НОВОЕ: Функция запуска игры Покер (Заглушка).
     */
    startPokerGame(table) {
        if (table.gameType !== 'Poker' || table.players.length < 2) return;
        
        // Сброс и раздача (упрощенно)
        table.deck.reset();
        table.communityCards = [];
        table.pot = 0;
        table.currentBet = 0;
        
        table.players.forEach(p => {
            p.hand = [table.deck.draw(), table.deck.draw()];
            p.active = true;
            p.isFolded = false;
            p.totalBet = 0;
            p.currentBet = 0;
        });

        // (Здесь должна быть сложная логика блайндов)
        
        // Начинаем ход первого активного игрока
        table.activePlayerIndex = 0; // Упрощенно
        table.state = 'PRE_FLOP'; // Двигаем состояние
        
        console.log(`[Poker] Game ${table.id} started. State: PRE_FLOP`);
    }

    
    // (hit, stand... блэкджека)
    // ...
    
    // --- НОВЫЕ СТАБЫ (ЗАГЛУШКИ) ДЛЯ ПОКЕРА ---
    fold(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];
        
        if (table && table.gameType === 'Poker') {
            console.log(`[STUB] Player ${player.id} FOLDED`);
            // (Здесь должна быть логика фолда)
            // Упрощенно:
            const tablePlayer = table.players.find(p => p.id === player.id);
            if (tablePlayer) tablePlayer.isFolded = true;
            
            // (Тут должна быть логика передачи хода)
            this.sendTableState(table);
            socket.emit('error_message', 'Вы сделали Фолд (Логика Покера в разработке).');
        }
    }

    callCheck(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];
        
        if (table && table.gameType === 'Poker') {
            console.log(`[STUB] Player ${player.id} CALL/CHECK`);
            // (Здесь должна быть логика)
            this.sendTableState(table);
            socket.emit('error_message', 'Вы сделали Чек/Колл (Логика Покера в разработке).');
        }
    }

    raise(socket, amount) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];

        if (table && table.gameType === 'Poker') {
            console.log(`[STUB] Player ${player.id} RAISED ${amount}`);
            // (Здесь должна быть логика)
            this.sendTableState(table);
            socket.emit('error_message', `Вы сделали Рейз ${amount} (Логика Покера в разработке).`);
        }
    }
    // --- КОНЕЦ СТАБОВ ДЛЯ ПОКЕРА ---


    // ИЗМЕНЕНО: Добавлена проверка Покера
    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player && player.currentTableId) {
             const tableId = player.currentTableId;
             this.leaveTable(socket); // Выходим
             
             // Доп. проверка, если leaveTable не успел
             const table = this.tables[tableId];
             if (table && table.gameType === 'Poker' && table.players.length < 2 && (table.state === 'READY_TO_START_POKER' || table.state === 'PRE_FLOP')) {
                  table.state = 'WAITING_FOR_PLAYERS';
                  this.sendTableState(table);
             }
        }
        
        Object.keys(this.quickPlayPool).forEach(gameType => {
            this.quickPlayPool[gameType] = this.quickPlayPool[gameType].filter(
                p => p.socket.id !== socket.id
            );
        });

        delete this.players[socket.id];
        this.broadcastTableList();
    }
    
    // --- ЛОГИКА МАТЧМЕЙКИНГА (без изменений) ---
    
    handleQuickPlay(socket, gameType) {
        const player = this.players[socket.id];
        if (!player || player.currentTableId) {
            socket.emit('error_message', 'Вы уже за столом.');
            return;
        }
        if (this.quickPlayPool[gameType].find(p => p.socket.id === socket.id)) {
             socket.emit('error_message', 'Вы уже в очереди.');
             return;
        }
        socket.emit('quick_play_pending', `Ищем игру (${gameType})...`);
        this.quickPlayPool[gameType].push({
            socket: socket,
            player: player,
            timestamp: Date.now()
        });
    }

    startMatchmakingLoop() {
        setInterval(() => {
            Object.keys(this.quickPlayPool).forEach(gameType => {
                const pool = this.quickPlayPool[gameType];
                if (pool.length === 0) return;

                // 1. Попытка найти существующий стол
                const availableTable = Object.values(this.tables).find(
                    t => t.gameType === gameType &&
                         !t.isPrivate &&
                         t.players.length < t.maxPlayers &&
                         (t.state === 'WAITING_FOR_PLAYERS' || t.state === 'WAITING_FOR_BETS')
                );

                if (availableTable) {
                    const entry = pool.shift();
                    if (entry) {
                         console.log(`[Matchmaking] ${entry.player.id} joining ${availableTable.id}`);
                         this.joinTable(entry.socket, availableTable.id, false, null);
                    }
                    return;
                }
                
                // 2. Логика 30 секунд
                const now = Date.now();
                const waitingOver30s = pool.filter(entry => (now - entry.timestamp) > 30000);
                const waitingUnder30s = pool.filter(entry => (now - entry.timestamp) <= 30000);

                if (waitingOver30s.length > 0) {
                    let playersForNewTable = waitingOver30s;
                    let maxPlayers = (gameType === 'Blackjack') ? 4 : 6;
                    if (playersForNewTable.length > maxPlayers) {
                        playersForNewTable = waitingOver30s.slice(0, maxPlayers);
                    }
                    
                    const remainingOver30s = waitingOver30s.slice(playersForNewTable.length);
                    this.quickPlayPool[gameType] = [...waitingUnder30s, ...remainingOver30s];

                    console.log(`[Matchmaking] Creating new table for ${playersForNewTable.length} players (waited > 30s)`);

                    // Создаем стол
                    const newTableId = `T${uuidv4().slice(0, 4)}`;
                    const newTable = {
                        id: newTableId,
                        gameType: gameType,
                        maxPlayers: maxPlayers,
                        minBet: gameType === 'Blackjack' ? 10 : 50,
                        isPrivate: false,
                        password: null,
                        state: 'WAITING_FOR_PLAYERS',
                        players: [],
                        deck: new Deck(),
                        dealerHand: []
                    };
                    if (gameType === 'Poker') {
                         newTable.communityCards = []; newTable.pot = 0; newTable.currentBet = 0;
                    }
                    this.tables[newTableId] = newTable;
                    this.broadcastTableList();

                    playersForNewTable.forEach(entry => {
                        this.joinTable(entry.socket, newTableId, false, null, true);
                    });
                }
            });
        }, 5000);
    }
    
    // --- GAME LOOP (без изменений) ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                if (table.gameType === 'Blackjack' && table.state === 'RESULTS') {
                    table.state = 'WAITING_FOR_BETS';
                    table.dealerHand = [];
                    table.players.forEach(p => {
                        p.bet = 0; p.hand = []; p.active = true;
                    });
                    this.sendTableState(table);
                }
            });
            this.broadcastTableList(); 
        }, 3000);
    }
}

module.exports = { GameServerLogic, calculateScore };