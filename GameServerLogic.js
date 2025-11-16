// GameServerLogic.js (Полный код с ИЗМЕНЕНИЯМИ)

const { v4: uuidv4 } = require('uuid');

// --- УТИЛИТЫ КАРТ ---
// (Код Deck и calculateScore остается без изменений)
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
        this.players = {}; // Состояние игроков
        this.tables = {
            'T1': { id: 'T1', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 2, minBet: 10, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'T2': { id: 'T2', gameType: 'Blackjack', currentPlayers: 0, maxPlayers: 6, minBet: 20, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] },
            'P1': { id: 'P1', gameType: 'Poker', currentPlayers: 0, maxPlayers: 4, minBet: 50, isPrivate: false, state: 'WAITING_FOR_PLAYERS', players: [], deck: new Deck(), dealerHand: [] }
        };
        
        // НОВОЕ: Очередь быстрой игры (матчмейкинг)
        this.quickPlayPool = {
            'Blackjack': [], // [{socket, player, timestamp}, ...]
            'Poker': []
        };

        this.startTableLoop(); // Запуск цикла обновления столов
        this.startMatchmakingLoop(); // НОВЫЙ: Запуск цикла матчмейкинга
    }
    
    // --- УПРАВЛЕНИЕ ЛОББИ И ПОЛЬЗОВАТЕЛЯМИ ---
    
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
            isPrivate: data.isPrivate, // ИСПРАВЛЕНО: Теперь используется
            password: data.password || null, // ИСПРАВЛЕНО: Теперь используется
            state: 'WAITING_FOR_PLAYERS',
            players: [],
            deck: new Deck(),
            dealerHand: []
        };
        this.tables[newTableId] = newTable;
        // Владелец сразу присоединяется (пароль не нужен, т.к. он создатель)
        this.joinTable(socket, newTableId, false, null, true); 
    }

    // ИСПРАВЛЕНО: Добавлен 'password' и 'isCreator'
    joinTable(socket, tableId, wantsBots, password, isCreator = false) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (!table) {
            socket.emit('error_message', 'Стол не найден.');
            return;
        }

        // НОВАЯ ПРОВЕРКА: Проверка пароля (создателю не нужно)
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

        table.players.push({ id: player.id, username: player.username, bet: 0, hand: [], active: true }); 
        player.currentTableId = tableId;
        table.currentPlayers = table.players.length;

        if (table.gameType === 'Blackjack' && (table.state === 'WAITING_FOR_PLAYERS' || table.state === 'RESULTS')) {
             table.state = 'WAITING_FOR_BETS';
        }
        
        socket.join(tableId);
        socket.emit('table_joined', { tableId: tableId, gameType: table.gameType, minBet: table.minBet });

        this.sendTableState(table);
        this.broadcastTableList();
    }

    leaveTable(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;

        const tableId = player.currentTableId;
        const table = this.tables[tableId];
        
        // (Логика возврата ставки...)
        const exitingPlayer = table.players.find(p => p.id === player.id);
        if (exitingPlayer && exitingPlayer.bet > 0) {
             player.balance += exitingPlayer.bet;
             socket.emit('auth_success', { id: player.id, balance: player.balance });
        }
        
        table.players = table.players.filter(p => p.id !== player.id);
        table.currentPlayers = table.players.length;

        socket.leave(tableId);
        player.currentTableId = null;
        
        if (table.players.length === 0) {
             table.state = 'WAITING_FOR_PLAYERS';
        } else if (table.state === 'READY_TO_START') {
            const allBetsIn = table.players.every(p => p.bet > 0);
            if (!allBetsIn) table.state = 'WAITING_FOR_BETS';
        }
        
        this.sendTableState(table); 

        socket.emit('return_to_lobby', { tables: this.broadcastTableList() }); 
        this.broadcastTableList(); 
    }
    
    // --- ЛОГИКА БЛЭКДЖЕКА ---

    sendTableState(table) {
        const tableState = {
            id: table.id,
            state: table.state,
            dealerHand: table.dealerHand,
            dealerScore: calculateScore(table.dealerHand),
            activePlayerId: table.activePlayerIndex !== undefined && table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex]
                               ? table.players[table.activePlayerIndex].id : null,
            players: table.players.map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                active: p.active
            }))
        };
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
    
    startGameCommand(socket, tableId) {
        // (Логика startGameCommand ... )
        const table = this.tables[tableId];
        if (!table || table.gameType !== 'Blackjack') {
             socket.emit('error_message', 'Стол не найден.'); return;
        }
        if (table.state === 'READY_TO_START') {
             this.startGame(table);
             this.sendTableState(table); 
        } else {
             socket.emit('error_message', 'Ожидаем ставки от всех игроков.');
        }
    }
    
    startGame(table) {
        // (Логика startGame ...)
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
    
    // (Методы hit, stand, checkResults, dealerPlay... должны быть здесь)

    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player && player.currentTableId) {
             this.leaveTable(socket); 
        }
        
        // НОВОЕ: Удаление из очередей матчмейкинга при дисконнекте
        Object.keys(this.quickPlayPool).forEach(gameType => {
            this.quickPlayPool[gameType] = this.quickPlayPool[gameType].filter(
                p => p.socket.id !== socket.id
            );
        });

        delete this.players[socket.id];
        this.broadcastTableList();
    }
    
    // --- НОВАЯ ЛОГИКА: МАТЧМЕЙКИНГ (БЫСТРАЯ ИГРА) ---
    
    /**
     * НОВОЕ: Вход в быструю игру.
     */
    handleQuickPlay(socket, gameType) {
        const player = this.players[socket.id];
        if (!player || player.currentTableId) {
            socket.emit('error_message', 'Вы уже за столом.');
            return;
        }
        
        // Проверяем, не в очереди ли уже
        if (this.quickPlayPool[gameType].find(p => p.socket.id === socket.id)) {
             socket.emit('error_message', 'Вы уже в очереди.');
             return;
        }

        socket.emit('quick_play_pending', `Ищем игру (${gameType})...`);
        
        // Добавляем в очередь
        this.quickPlayPool[gameType].push({
            socket: socket,
            player: player,
            timestamp: Date.now()
        });
        
        // (Логика обработки очереди будет в startMatchmakingLoop)
    }

    /**
     * НОВОЕ: Цикл обработки матчмейкинга (каждые 5 сек).
     */
    startMatchmakingLoop() {
        setInterval(() => {
            Object.keys(this.quickPlayPool).forEach(gameType => {
                const pool = this.quickPlayPool[gameType];
                if (pool.length === 0) return;

                // 1. Попытка найти существующий публичный стол с местом
                const availableTable = Object.values(this.tables).find(
                    t => t.gameType === gameType &&
                         !t.isPrivate && // Только публичные
                         t.players.length < t.maxPlayers &&
                         (t.state === 'WAITING_FOR_PLAYERS' || t.state === 'WAITING_FOR_BETS')
                );

                if (availableTable) {
                    // Нашли стол! Добавляем первого игрока из очереди
                    const entry = pool.shift(); // Берем первого
                    if (entry) {
                         console.log(`[Matchmaking] ${entry.player.id} joining ${availableTable.id}`);
                         this.joinTable(entry.socket, availableTable.id, false, null); // null = нет пароля
                    }
                    return; // Обрабатываем по одному за тик
                }
                
                // 2. Логика 30 секунд (как просил пользователь)
                const now = Date.now();
                const waitingOver30s = pool.filter(entry => (now - entry.timestamp) > 30000); // 30 сек
                const waitingUnder30s = pool.filter(entry => (now - entry.timestamp) <= 30000);

                if (waitingOver30s.length > 0) {
                    // Есть игроки, ждущие > 30 сек.
                    // "запускается с одним или более игроками" -> Создаем для них стол.
                    
                    let playersForNewTable = waitingOver30s;
                    
                    let maxPlayers = (gameType === 'Blackjack') ? 4 : 6;
                    
                    // Берем тех, кто ждал > 30 сек, но не больше maxPlayers
                    if (playersForNewTable.length > maxPlayers) {
                        playersForNewTable = waitingOver30s.slice(0, maxPlayers);
                    }
                    
                    // Обновляем пул (оставляем тех, кто < 30s и тех, кто не влез > 30s)
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
                    this.tables[newTableId] = newTable;
                    this.broadcastTableList();

                    // Присоединяем всех игроков к столу
                    playersForNewTable.forEach(entry => {
                        this.joinTable(entry.socket, newTableId, false, null, true); // true = создатель (пропустит проверку пароля)
                    });
                }
                // Если игроки ждут < 30 сек, мы просто ждем (п.1 найдет им стол или п.2 создаст)
            });
        }, 5000); // Проверяем каждые 5 секунд
    }
    
    // --- ПАКЕТНЫЙ ЦИКЛ ОБНОВЛЕНИЯ (GAME LOOP) ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                if (table.gameType === 'Blackjack' && table.state === 'RESULTS') {
                    // (Логика сброса раунда...)
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