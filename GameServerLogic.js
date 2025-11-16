// GameServerLogic.js (Полный код с ИЗМЕНЕНИЯМИ)

const { v4: uuidv4 } = require('uuid');

// --- УТИЛИТЫ КАРТ (без изменений) ---
const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S'];
function calculateScore(hand) {
    if (!hand) return 0; // Защита
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
            // (Столы по умолчанию)
        };
        
        this.quickPlayPool = {
            'Blackjack': [],
            'Poker': []
        };

        this.startTableLoop();
        this.startMatchmakingLoop();
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
            isPrivate: data.isPrivate,
            password: data.password || null,
            state: 'WAITING_FOR_PLAYERS',
            players: [],
            deck: new Deck(),
            dealerHand: [],
            lastResult: null // НОВОЕ: Для сообщения о выигрыше
        };
        
        if (data.gameType === 'Poker') {
            newTable.communityCards = [];
            newTable.pot = 0;
            newTable.currentBet = 0;
        }
        
        this.tables[newTableId] = newTable;
        this.joinTable(socket, newTableId, false, null, true); 
    }

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

        const playerState = { id: player.id, username: player.username, bet: 0, hand: [], active: true, score: 0 };
        if (table.gameType === 'Poker') {
             playerState.isFolded = false;
             playerState.totalBet = 0;
             playerState.currentBet = 0;
        }
        
        table.players.push(playerState); 
        player.currentTableId = tableId;
        table.currentPlayers = table.players.length;

        if (table.gameType === 'Blackjack' && (table.state === 'WAITING_FOR_PLAYERS' || table.state === 'RESULTS')) {
             table.state = 'WAITING_FOR_BETS';
        }
        
        if (table.gameType === 'Poker' && table.state === 'WAITING_FOR_PLAYERS' && table.players.length >= 2) {
             table.state = 'READY_TO_START_POKER';
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
        
        // (Логика возврата ставки, если игра не началась)
        const exitingPlayer = table.players.find(p => p.id === player.id);
        if (exitingPlayer && exitingPlayer.bet > 0 && table.state === 'WAITING_FOR_BETS') {
             player.balance += exitingPlayer.bet;
             socket.emit('auth_success', { id: player.id, balance: player.balance });
        }
        
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
        } else if (table.gameType === 'Poker') {
             if (table.players.length < 2 && (table.state !== 'WAITING_FOR_PLAYERS')) {
                 table.state = 'WAITING_FOR_PLAYERS';
             }
        }
        
        // (Если активный игрок вышел, передать ход)
        if (table.state === 'PLAYER_TURN' && exitingPlayer && table.activePlayerId === exitingPlayer.id) {
            this.findNextPlayer(table);
        }
         if (table.gameType === 'Poker' && table.state !== 'WAITING_FOR_PLAYERS' && exitingPlayer && table.activePlayerId === exitingPlayer.id) {
             this.findNextPlayerPoker(table);
         }
        
        this.sendTableState(table); 

        socket.emit('return_to_lobby', { tables: this.broadcastTableList() }); 
        this.broadcastTableList(); 
    }
    
    // --- ОБЩАЯ ЛОГИКА ИГР ---

    sendTableState(table) {
        if (!table) return;
        
        const tableState = {
            id: table.id,
            state: table.state,
            players: [],
            lastResult: table.lastResult || null
        };

        if (table.gameType === 'Blackjack') {
            tableState.dealerHand = table.dealerHand;
            tableState.dealerScore = calculateScore(table.dealerHand);
            tableState.activePlayerId = (table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex]) ? table.players[table.activePlayerIndex].id : null;
            
            tableState.players = table.players.map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: p.score, // Используем сохраненный счет
                active: p.active
            }));
        }

        if (table.gameType === 'Poker') {
            tableState.communityCards = table.communityCards;
            tableState.pot = table.pot;
            tableState.currentBet = table.currentBet;
            tableState.activePlayerId = (table.activePlayerIndex !== -1 && table.players[table.activePlayerIndex]) ? table.players[table.activePlayerIndex].id : null;

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
    
    // (Обработка команды Старт)
    startGameCommand(socket, tableId) {
        const table = this.tables[tableId];
        if (!table) return socket.emit('error_message', 'Стол не найден.');
        
        if (table.gameType === 'Blackjack') {
            if (table.state === 'READY_TO_START') {
                 this.startGame(table);
                 this.sendTableState(table); 
            }
        }
        
        if (table.gameType === 'Poker') {
            if (table.state === 'READY_TO_START_POKER') {
                 this.startPokerGame(table);
                 this.sendTableState(table);
            }
        }
    }
    
    // --- ЛОГИКА БЛЭКДЖЕКА (ДОБАВЛЕНА) ---
    
    placeBet(socket, tableId, amount) {
        // (Логика placeBet ... )
        const player = this.players[socket.id];
        const table = this.tables[tableId];
        if (!table || table.state !== 'WAITING_FOR_BETS' || table.gameType !== 'Blackjack') {
             return socket.emit('error_message', 'Не время для ставок.');
        }
        const tablePlayer = table.players.find(p => p.id === player.id);
        if (tablePlayer) {
             if (tablePlayer.bet > 0) {
                 return socket.emit('error_message', 'Вы уже сделали ставку.');
             }
             if (player.balance < amount) {
                 return socket.emit('error_message', 'Недостаточно средств.');
             }
            tablePlayer.bet = amount;
            player.balance -= amount;
            socket.emit('auth_success', { id: player.id, balance: player.balance });
            
            const allBetsIn = table.players.every(p => p.bet > 0 || !p.active);
            if (allBetsIn && table.players.length > 0) {
                table.state = 'READY_TO_START'; 
            }
             this.sendTableState(table);
        }
    }
    
    startGame(table) {
        if (table.gameType !== 'Blackjack') return;
        
        table.deck.reset(); 
        table.dealerHand = [];
        table.lastResult = null; // Сброс результата
        
        table.players.forEach(p => {
            p.hand = [];
            p.score = 0;
            // Игрок активен, только если сделал ставку
            p.active = (p.bet > 0); 
            if (p.active) {
                p.hand.push(table.deck.draw());
                p.hand.push(table.deck.draw());
                p.score = calculateScore(p.hand);
            }
        });
        
        table.dealerHand.push(table.deck.draw());
        table.dealerHand.push(table.deck.draw());
        
        // Начинаем ход первого активного игрока
        table.activePlayerIndex = table.players.findIndex(p => p.active);

        if (table.activePlayerIndex !== -1) {
            table.state = 'PLAYER_TURN'; 
        } else {
             table.state = 'WAITING_FOR_BETS'; // Никто не сделал ставку
        }
    }
    
    hit(socket, tableId) {
        const table = this.tables[tableId];
        const player = table.players[table.activePlayerIndex];
        
        if (!table || !player || player.id !== socket.id || table.state !== 'PLAYER_TURN') {
            return socket.emit('error_message', 'Сейчас не ваш ход.');
        }

        player.hand.push(table.deck.draw());
        player.score = calculateScore(player.hand);

        if (player.score > 21) {
            // Перебор
            player.active = false; // Игрок проиграл
            this.findNextPlayer(table);
        } else if (player.score === 21) {
            // Авто-Stand
            this.findNextPlayer(table);
        }
        
        this.sendTableState(table);
    }

    stand(socket, tableId) {
        const table = this.tables[tableId];
        const player = table.players[table.activePlayerIndex];
        
        if (!table || !player || player.id !== socket.id || table.state !== 'PLAYER_TURN') {
            return socket.emit('error_message', 'Сейчас не ваш ход.');
        }
        
        // Просто передаем ход
        this.findNextPlayer(table);
        this.sendTableState(table);
    }

    findNextPlayer(table) {
        let nextIndex = -1;
        for (let i = table.activePlayerIndex + 1; i < table.players.length; i++) {
            if (table.players[i].active) {
                nextIndex = i;
                break;
            }
        }
        
        if (nextIndex !== -1) {
            table.activePlayerIndex = nextIndex;
        } else {
            // Ходы игроков закончились
            table.activePlayerIndex = -1;
            table.state = 'DEALER_TURN';
            this.dealerPlay(table);
        }
    }

    dealerPlay(table) {
        let dealerScore = calculateScore(table.dealerHand);
        
        while (dealerScore < 17) {
            table.dealerHand.push(table.deck.draw());
            dealerScore = calculateScore(table.dealerHand);
        }
        
        table.state = 'RESULTS';
        this.checkResults(table);
    }
    
    checkResults(table) {
        const dealerScore = calculateScore(table.dealerHand);
        let results = [];

        table.players.forEach(p => {
            if (p.bet > 0) { // Только те, кто ставил
                const player = this.players[p.id];
                const pScore = p.score;
                
                if (pScore > 21) {
                    // Игрок проиграл (Перебор)
                    results.push(`${p.username}: Перебор (${pScore})`);
                    // (Деньги уже сняты)
                } else if (dealerScore > 21) {
                    // Дилер проиграл (Перебор)
                    player.balance += p.bet * 2;
                    results.push(`${p.username}: Выигрыш! (Дилер ${dealerScore})`);
                } else if (pScore > dealerScore) {
                    // Игрок выиграл
                    player.balance += p.bet * 2;
                    results.push(`${p.username}: Выигрыш! (${pScore} > ${dealerScore})`);
                } else if (pScore < dealerScore) {
                    // Игрок проиграл
                    results.push(`${p.username}: Проигрыш (${pScore} < ${dealerScore})`);
                } else {
                    // Ничья
                    player.balance += p.bet;
                    results.push(`${p.username}: Ничья (${pScore})`);
                }
                
                this.io.to(p.id).emit('auth_success', { id: player.id, balance: player.balance });
            }
        });
        
        table.lastResult = `Результаты: ${results.join(', ')}`;
        // Цикл (startTableLoop) сам переведет в WAITING_FOR_BETS
    }

    // --- ЛОГИКА ПОКЕРА (ИСПРАВЛЕНЫ ЗАГЛУШКИ) ---
    
    startPokerGame(table) {
        if (table.gameType !== 'Poker' || table.players.length < 2) return;
        
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

        table.activePlayerIndex = 0; // (Упрощенно, без блайндов)
        table.state = 'PRE_FLOP';
        
        console.log(`[Poker] Game ${table.id} started. State: PRE_FLOP`);
    }

    fold(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];
        
        if (table && table.gameType === 'Poker' && table.players[table.activePlayerIndex].id === socket.id) {
            console.log(`[Poker] Player ${player.id} FOLDED`);
            const tablePlayer = table.players.find(p => p.id === player.id);
            if (tablePlayer) {
                tablePlayer.isFolded = true;
                tablePlayer.active = false;
            }
            this.findNextPlayerPoker(table); // Передаем ход
            this.sendTableState(table);
        }
    }

    callCheck(socket) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];
        
        if (table && table.gameType === 'Poker' && table.players[table.activePlayerIndex].id === socket.id) {
            console.log(`[Poker] Player ${player.id} CALL/CHECK`);
            // (Логика ставок...)
            this.findNextPlayerPoker(table); // Передаем ход
            this.sendTableState(table);
        }
    }

    raise(socket, amount) {
        const player = this.players[socket.id];
        if (!player || !player.currentTableId) return;
        const table = this.tables[player.currentTableId];

        if (table && table.gameType === 'Poker' && table.players[table.activePlayerIndex].id === socket.id) {
            console.log(`[Poker] Player ${player.id} RAISED ${amount}`);
            // (Логика ставок...)
            this.findNextPlayerPoker(table); // Передаем ход
            this.sendTableState(table);
        }
    }
    
    // НОВОЕ: Передача хода в Покере (упрощенно)
    findNextPlayerPoker(table) {
        let nextIndex = -1;
        let activePlayers = table.players.filter(p => !p.isFolded && p.active);
        
        // (Очень упрощенный цикл, не учитывает круги ставок)
        for (let i = table.activePlayerIndex + 1; i < table.players.length; i++) {
            if (!table.players[i].isFolded) {
                nextIndex = i;
                break;
            }
        }
        
        // Если дошли до конца, ищем с начала
        if (nextIndex === -1) {
            for (let i = 0; i < table.activePlayerIndex; i++) {
                 if (!table.players[i].isFolded) {
                    nextIndex = i;
                    break;
                }
            }
        }
        
        // (Если остался 1 игрок, раунд должен закончиться - пока пропускаем)
        
        if (nextIndex !== -1) {
            table.activePlayerIndex = nextIndex;
        } else {
            // Если все-таки не нашли (например, все сфолдили)
            table.activePlayerIndex = table.activePlayerIndex; // Оставляем
            // (Тут должен быть переход на FLOP, TURN... пока пропускаем)
            console.log("[Poker] Round complete (stub)");
        }
    }

    // --- КОНЕЦ ЛОГИКИ ПОКЕРА ---


    // (Обработка дисконнекта)
    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player) {
            if (player.currentTableId) {
                 this.leaveTable(socket); 
            }
            // (Удаление из пула матчмейкинга)
            Object.keys(this.quickPlayPool).forEach(gameType => {
                this.quickPlayPool[gameType] = this.quickPlayPool[gameType].filter(
                    p => p.socket.id !== socket.id
                );
            });
            delete this.players[socket.id];
        }
        this.broadcastTableList();
    }
    
    // --- ЛОГИКА МАТЧМЕЙКИНГА (без изменений) ---
    
    handleQuickPlay(socket, gameType) {
        const player = this.players[socket.id];
        if (!player || player.currentTableId) {
            return socket.emit('error_message', 'Вы уже за столом.');
        }
        if (this.quickPlayPool[gameType].find(p => p.socket.id === socket.id)) {
             return socket.emit('error_message', 'Вы уже в очереди.');
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
                         (t.state === 'WAITING_FOR_PLAYERS' || (gameType === 'Blackjack' && t.state === 'WAITING_FOR_BETS'))
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
                    
                    // Создаем стол (симулируем вызов createTable)
                     const newTableId = `T${uuidv4().slice(0, 4)}`;
                     const newTable = {
                        id: newTableId,
                        gameType: gameType,
                        maxPlayers: maxPlayers,
                        minBet: gameType === 'Blackjack' ? 10 : 50,
                        isPrivate: false,
                        password: null,
                        state: 'WAITING_FOR_PLAYERS',
                        players: [], deck: new Deck(), dealerHand: [], lastResult: null
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
    
    // --- GAME LOOP ---
    startTableLoop() {
        setInterval(() => {
            Object.values(this.tables).forEach(table => {
                // Сброс раунда Блэкджека
                if (table.gameType === 'Blackjack' && table.state === 'RESULTS') {
                    // Даем 5 секунд на просмотр результатов
                    if (!table.resultTimer) {
                         table.resultTimer = setTimeout(() => {
                            table.state = 'WAITING_FOR_BETS';
                            table.dealerHand = [];
                            table.players.forEach(p => {
                                p.bet = 0;
                                p.hand = [];
                                p.score = 0;
                                p.active = true; // Снова активны
                            });
                            this.sendTableState(table);
                            delete table.resultTimer;
                         }, 5000); // 5 секунд
                    }
                }
            });
            // (Убрал broadcastTableList() отсюда, чтобы не спамить)
        }, 1000); // Проверяем каждую секунду
    }
}

module.exports = { GameServerLogic, calculateScore };