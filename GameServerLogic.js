// GameServerLogic.js (ИСПРАВЛЕННАЯ ВЕРСИЯ)

// --- Утилиты Карт ---
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
        if (this.cards.length === 0) {
            this.reset();
        }
        return this.cards.pop();
    }
}

class Player {
    constructor(id, username, balance, socketId) {
        this.id = id;
        this.username = username;
        this.balance = balance;
        this.socketId = socketId;
        this.hand = [];
        this.bet = 0;
        this.stood = false;
        this.active = true;
    }
}

// --- БАЗОВЫЙ КЛАСС СТОЛА ---
class Table {
    constructor(id, gameType, creatorId, maxPlayers, minBet, isPrivate, password) {
        this.io = null; // Будет установлен GameServerLogic
        this.id = id;
        this.gameType = gameType; // 'Blackjack' или 'Poker'
        this.creatorId = creatorId;
        this.maxPlayers = maxPlayers;
        this.minBet = minBet;
        this.isPrivate = isPrivate;
        this.password = password;
        this.players = []; // Массив объектов Player
        this.state = 'WAITING_FOR_PLAYERS'; // НОВЫЙ начальный стейт
        this.minPlayersToStart = 2; // МИНИМУМ 2 игрока для начала
        this.activePlayerIndex = -1;
    }

    setIO(io) {
        this.io = io;
    }
    
    // Переопределяется в подклассах
    addPlayer(player) {
        this.players.push(player);
        this.checkWaitState();
    }

    removePlayer(playerId) {
        this.players = this.players.filter(p => p.id !== playerId);
        this.checkWaitState();
        if (this.players.length === 0) return true; // Стол пуст
        return false;
    }
    
    checkWaitState() {
         if (this.players.length >= this.minPlayersToStart && this.state === 'WAITING_FOR_PLAYERS') {
            this.state = 'WAITING_FOR_BETS';
        } else if (this.players.length < this.minPlayersToStart) {
            this.state = 'WAITING_FOR_PLAYERS';
        }
        this.sendTableState();
    }

    sendTableState() {
        // Базовая реализация
        this.io.to(this.id).emit('table_state', {
            id: this.id,
            state: this.state,
            gameType: this.gameType,
            minBet: this.minBet,
            maxPlayers: this.maxPlayers,
            currentPlayers: this.players.length,
            // ... (дополнительные данные)
            players: this.players.map(p => ({
                id: p.id,
                username: p.username,
                balance: p.balance,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                stood: p.stood,
                isActive: this.state === 'PLAYER_TURN' && this.players[this.activePlayerIndex]?.id === p.id
            }))
        });
    }
}

// --- ЛОГИКА БЛЭКДЖЕКА ---
class BlackjackTable extends Table {
    constructor(...args) {
        super(...args);
        this.gameType = 'Blackjack';
        this.dealerHand = [];
        this.deck = new Deck();
    }

    sendTableState() {
        const tableState = {
            id: this.id,
            state: this.state,
            gameType: this.gameType,
            minBet: this.minBet,
            maxPlayers: this.maxPlayers,
            currentPlayers: this.players.length,
            // Дилер: первая карта скрыта, пока не наступит DEALER_TURN
            dealerHand: this.state === 'DEALER_TURN' || this.state === 'GAME_OVER' ? this.dealerHand : [this.dealerHand[0], '??'],
            dealerScore: this.state === 'DEALER_TURN' || this.state === 'GAME_OVER' ? calculateScore(this.dealerHand) : calculateScore([this.dealerHand[0]]),
            
            players: this.players.map(p => ({
                id: p.id,
                username: p.username,
                bet: p.bet,
                hand: p.hand,
                score: calculateScore(p.hand),
                stood: p.stood,
                isActive: this.state === 'PLAYER_TURN' && this.players[this.activePlayerIndex]?.id === p.id
            }))
        };
        this.io.to(this.id).emit('table_state', tableState);
    }
    
    // Установить ставку
    placeBet(playerId, amount) {
        if (this.state !== 'WAITING_FOR_BETS') return false;
        const player = this.players.find(p => p.id === playerId);
        if (!player || amount < this.minBet || player.bet > 0) return false;
        
        player.bet = amount;
        this.sendTableState();
        
        // Проверяем, все ли сделали ставки
        const playersReady = this.players.filter(p => p.bet > 0);
        if (playersReady.length === this.players.length && playersReady.length > 0) {
            this.startGame();
        }
        return true;
    }
    
    // Начало раздачи
    startGame() {
        this.deck.reset();
        this.dealerHand = [];
        this.players.forEach(p => {
            p.hand = [];
            p.stood = false;
            p.active = p.bet > 0; // Активны только те, кто сделал ставку
        });
        
        this.state = 'DEALING';
        
        // Раздача (по две карты каждому активному игроку и дилеру)
        for(let i = 0; i < 2; i++) {
            this.players.filter(p => p.active).forEach(p => p.hand.push(this.deck.draw()));
            this.dealerHand.push(this.deck.draw());
        }

        // Переходим к ходу первого игрока
        this.activePlayerIndex = this.players.findIndex(p => p.active);
        if (this.activePlayerIndex !== -1) {
            this.state = 'PLAYER_TURN';
        } else {
            // Никто не поставил, переходим к GAME_OVER или заново к WAITING_FOR_BETS
            this.state = 'WAITING_FOR_BETS';
        }
        this.sendTableState();
    }
    
    // Смена хода (КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ)
    advanceTurn() {
        if (this.state !== 'PLAYER_TURN') return;

        let nextIndex = (this.activePlayerIndex + 1) % this.players.length;
        let originalStart = nextIndex;

        // Цикл для поиска следующего активного игрока
        do {
            const nextPlayer = this.players[nextIndex];
            const score = calculateScore(nextPlayer.hand);
            
            // Игрок активен (сделал ставку), не "спасовал" и не перебрал
            if (nextPlayer.active && nextPlayer.bet > 0 && !nextPlayer.stood && score <= 21) {
                this.activePlayerIndex = nextIndex;
                this.sendTableState();
                return; // Найден следующий игрок
            }

            nextIndex = (nextIndex + 1) % this.players.length;

        } while (nextIndex !== originalStart);
        
        // Если все игроки закончили свой ход (stood, bust, или неактивны), наступает ход дилера
        this.state = 'DEALER_TURN';
        this.activePlayerIndex = -1; // Сброс активного индекса
        this.dealerPlay();
    }
    
    // Действие "Взять карту" (Hit)
    handleHit(playerId) {
        const player = this.players.find(p => p.id === playerId);
        const activePlayer = this.players[this.activePlayerIndex];

        if (!player || this.state !== 'PLAYER_TURN' || player.id !== activePlayer?.id) {
            this.io.to(playerId).emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        player.hand.push(this.deck.draw());
        const score = calculateScore(player.hand);
        
        if (score > 21) {
            // Перебор (Bust): игрок завершает ход
            player.stood = true; 
            this.sendTableState();
            this.advanceTurn(); // АВТОМАТИЧЕСКАЯ ПЕРЕДАЧА ХОДА
        } else {
            this.sendTableState(); // Обновляем карты игрока
        }
    }

    // Действие "Хватит" (Stand)
    handleStand(playerId) {
        const player = this.players.find(p => p.id === playerId);
        const activePlayer = this.players[this.activePlayerIndex];
        
        if (!player || this.state !== 'PLAYER_TURN' || player.id !== activePlayer?.id) {
            this.io.to(playerId).emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        player.stood = true;
        this.sendTableState();
        this.advanceTurn(); // КОРРЕКТНАЯ ПЕРЕДАЧА ХОДА
    }

    dealerPlay() {
        this.sendTableState(); // Сначала показываем вторую карту дилера
        
        const dealerTurn = setInterval(() => {
            const dealerScore = calculateScore(this.dealerHand);
            
            if (dealerScore < 17) {
                this.dealerHand.push(this.deck.draw());
                this.sendTableState();
            } else {
                clearInterval(dealerTurn);
                this.checkResults();
            }
        }, 1500); // Дилер берет карту каждые 1.5 секунды
    }

    checkResults() {
        this.state = 'GAME_OVER';
        const dealerScore = calculateScore(this.dealerHand);
        let results = [];

        this.players.filter(p => p.bet > 0).forEach(player => {
            let winAmount = 0;
            const playerScore = calculateScore(player.hand);
            let resultType = 'Lose';

            if (playerScore > 21) {
                // Игрок перебрал
                resultType = 'Bust';
            } else if (dealerScore > 21) {
                // Дилер перебрал
                winAmount = player.bet * 2; 
                resultType = 'Win';
            } else if (playerScore === dealerScore) {
                // Ничья
                winAmount = player.bet; 
                resultType = 'Push';
            } else if (playerScore > dealerScore) {
                // Игрок победил
                winAmount = player.bet * 2; 
                resultType = 'Win';
            } 
            
            // Обновление баланса (если есть функция) - здесь просто отправляем результат
            results.push({ playerId: player.id, result: resultType, winAmount, bet: player.bet, newBalance: 0 }); 
            player.bet = 0; // Сброс ставки для следующего раунда
            
            // Эмитим индивидуальные результаты, чтобы GameServerLogic мог обновить баланс
            this.io.to(player.socketId).emit('blackjack_result', { resultType, winAmount });
        });
        
        this.sendTableState(); 
        
        // После 5 секунд возвращаемся к ставкам
        setTimeout(() => {
            this.checkWaitState(); // Проверить, достаточно ли игроков для WAITING_FOR_BETS
        }, 5000);
    }
    
    // ... (добавить методы для PokerTable - упрощенно) ...
}


// --- ЛОГИКА ПОКЕРА (УПРОЩЕННО) ---
class PokerTable extends Table {
    constructor(...args) {
        super(...args);
        this.gameType = 'Poker';
        // Упрощаем логику для демонстрации ожидания игроков
        this.deck = new Deck();
        this.pot = 0;
        this.communityCards = [];
        this.currentBet = 0;
        this.currentRound = 'Preflop';
        this.hasStarted = false;
        this.minPlayersToStart = 2; // Минимум 2 игрока для покера
    }

    // Упрощенная логика для покера, чтобы просто показать, что она работает с лобби
    startGame() {
        if (this.players.length < this.minPlayersToStart) {
            this.state = 'WAITING_FOR_PLAYERS';
            this.sendTableState();
            return;
        }
        // ... Логика начала покера ...
        this.state = 'PREFLOP';
        this.hasStarted = true;
        this.sendTableState();
    }
    
    // ... (Методы fold/call/raise для покера, здесь не реализованы, но используются в server.js) ...
}

// --- ОСНОВНАЯ ЛОГИКА СЕРВЕРА ---
class GameServerLogic {
    constructor(io) {
        this.io = io;
        this.players = {}; // { socketId: Player }
        this.tables = {}; // { tableId: Table }
        this.nextPlayerId = 1;
        this.nextTableId = 1;

        // Запуск цикла обновления столов (если нужно, но для MVP не обязательно)
        // this.startTableLoop();
        
        // Создание тестового стола по умолчанию
        this.createTable(null, { 
            gameType: 'Blackjack', 
            maxPlayers: 4, 
            minBet: 10, 
            isPrivate: false,
            // Флаг, чтобы не добавлять игрока, если это тестовый стол
            isDefault: true 
        }); 
    }

    // ... (handleAuth, handleDisconnect, leaveTable - оставляем как было)

    broadcastTableList() {
        const tableList = Object.values(this.tables).map(table => ({
            id: table.id,
            gameType: table.gameType,
            currentPlayers: table.players.length,
            maxPlayers: table.maxPlayers,
            minBet: table.minBet,
            isPrivate: table.isPrivate,
            state: table.state
        }));
        this.io.emit('table_list', tableList);
        return tableList;
    }
    
    // НОВЫЙ МЕТОД: Создание стола
    createTable(socket, data) {
        const player = socket ? this.players[socket.id] : null;
        if (socket && (!player || player.currentTableId)) {
            return socket.emit('error_message', 'Вы уже за столом.');
        }
        
        const tableId = `T${this.nextTableId++}`;
        const gameType = data.gameType || 'Blackjack';
        const maxPlayers = parseInt(data.maxPlayers) || 4; 
        const minBet = parseInt(data.minBet) || 10;
        const isPrivate = data.isPrivate || false;
        const password = data.password || null;
        
        let newTable;
        if (gameType === 'Blackjack') {
            newTable = new BlackjackTable(tableId, gameType, player?.id, maxPlayers, minBet, isPrivate, password);
        } else if (gameType === 'Poker') {
            newTable = new PokerTable(tableId, gameType, player?.id, maxPlayers, minBet, isPrivate, password);
        } else {
            return socket.emit('error_message', 'Неизвестный тип игры.');
        }

        newTable.setIO(this.io); // Устанавливаем IO для возможности широковещания
        this.tables[tableId] = newTable;
        console.log(`Table created: ${tableId} (${gameType}) by ${player?.username || 'System'}`);
        
        // Автоматически присоединяем создателя
        if (socket && !data.isDefault) {
            this.joinTable(socket, tableId);
        }
        
        this.broadcastTableList();
    }
    
    // ИСПРАВЛЕННЫЙ МЕТОД: Присоединение к столу
    joinTable(socket, tableId) {
        const table = this.tables[tableId];
        const player = this.players[socket.id];

        if (!table || !player) { 
            return socket.emit('error_message', 'Стол не найден или ошибка игрока.'); 
        }

        if (table.players.length >= table.maxPlayers) {
            return socket.emit('error_message', 'Комната заполнена.');
        }

        if (player.currentTableId) {
            this.leaveTable(socket);
        }
        
        // Проверяем приватность (если нужно)
        // ... (логика проверки пароля) ...
        
        player.currentTableId = tableId;
        socket.join(tableId);
        
        const newPlayer = new Player(player.id, player.username, player.balance, socket.id);
        
        table.addPlayer(newPlayer); // Используем метод addPlayer стола
        
        // Успешное присоединение
        socket.emit('join_success', { table: table.id, gameType: table.gameType });
        this.broadcastTableList();
    }

    // --- ОБЕРТКИ ДЕЙСТВИЙ (ПЕРЕКЛЮЧЕНИЕ МЕЖДУ СТОЛАМИ) ---
    placeBet(socket, tableId, amount) {
        const table = this.tables[tableId];
        const player = this.players[socket.id];
        
        if (table && table.placeBet(player.id, amount)) {
             // Обновляем баланс
             player.balance -= amount;
             socket.emit('auth_success', { id: player.id, balance: player.balance });
        } else {
            socket.emit('error_message', 'Не удалось принять ставку.');
        }
    }
    
    hit(socket, tableId) {
        this.tables[tableId]?.handleHit(socket.id);
    }

    stand(socket, tableId) {
        this.tables[tableId]?.handleStand(socket.id);
    }
    
    // ... (pokerAction, leaveTable, handleDisconnect, handleAuth) ...
    // Внимание: Здесь не реализованы handleAuth, leaveTable и blackjack_result, 
    // но они должны быть в вашей полной версии.
    
    // ... (Оставшиеся методы)
}

module.exports = { GameServerLogic, calculateScore };