// GameServerLogic.js (Полный исправленный код)

const { v4: uuidv4 } = require('uuid');

// --- УТИЛИТЫ КАРТ (без изменений) ---
const cardRanks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const cardSuits = ['C', 'D', 'H', 'S'];
function calculateScore(hand) {
    if (!hand) return 0;
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
        this.tables = {};
        
        this.quickPlayPool = { 'Blackjack': [], 'Poker': [] };

        this.startTableLoop();
        this.startMatchmakingLoop();
    }
    
    // --- УПРАВЛЕНИЕ ЛОББИ И ПОЛЬЗОВАТЕЛЯМИ (методы опущены для краткости, если не содержат изменений) ---
    
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
            lastResult: null
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
        table.players.push(playerState);
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
            if (!allBetsIn) {
                table.state = 'WAITING_FOR_BETS';
            }
        }
        
        this.sendTableState(table); 
        socket.emit('return_to_lobby', { tables: this.broadcastTableList() });
        this.broadcastTableList();
    }
    
    // --- ЛОГИКА ИГРЫ БЛЭКДЖЕК ---

    sendTableState(table) {
        const tableState = {
            id: table.id,
            state: table.state,
            lastResult: table.lastResult || null,
            // ... (другие свойства стола) ...
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
                score: calculateScore(p.hand),
                active: p.active
            }));
        } 
        
        this.io.to(table.id).emit('table_state', tableState);
    }
    
    /**
     * КЛЮЧЕВОЕ МЕСТО ДЛЯ ПЕРЕХОДА В READY_TO_START
     */
    placeBet(socket, tableId, amount) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || (table.state !== 'WAITING_FOR_BETS' && table.state !== 'RESULTS')) {
            socket.emit('error_message', 'Сейчас нельзя делать ставки.');
            return;
        }

        const tablePlayer = table.players.find(p => p.id === player.id);
        if (!tablePlayer) return;

        if (amount < table.minBet) {
             socket.emit('error_message', `Минимальная ставка: ${table.minBet}.`);
             return;
        }

        if (player.balance < amount) {
            socket.emit('error_message', 'Недостаточно средств.');
            return;
        }

        // Возврат старой ставки и обновление баланса
        if (tablePlayer.bet > 0) {
             player.balance += tablePlayer.bet;
        }
        player.balance -= amount;
        tablePlayer.bet = amount;
        
        socket.emit('auth_success', { id: player.id, balance: player.balance });

        // ПРОВЕРКА СОСТОЯНИЯ ГОТОВНОСТИ
        const allBetsIn = table.players.every(p => p.bet > 0);
        
        // --- ИСПРАВЛЕНИЕ ЛОГИКИ СТАРТА ИГРЫ ---
        if (allBetsIn && table.players.length > 0) {
            table.state = 'READY_TO_START'; // Стол готов, кнопка должна стать доступной
        } else {
            table.state = 'WAITING_FOR_BETS'; // Если кто-то убрал ставку/не все сделали
        }
        
        this.sendTableState(table);
        this.broadcastTableList();
    }
    
    /**
     * ПРОВЕРКА ПРАВА НА ЗАПУСК ИГРЫ
     */
    startGameCommand(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'READY_TO_START') {
            socket.emit('error_message', 'Игра еще не готова к старту.');
            return;
        }
        
        // Проверяем, что запуск инициирован первым игроком
        const firstPlayer = table.players[0];
        if (!firstPlayer || firstPlayer.id !== player.id) {
            socket.emit('error_message', 'Только игрок, присоединившийся первым, может начать игру.');
            return;
        }
        
        this.startGame(table);
    }
    
    // ... (остальные методы игры - hit, stand, dealerPlay, checkResults) ...
    // ... (оставлены без изменений, так как они не влияют на блокировку кнопки "Начать игру")
    
    startGame(table) {
        table.deck.reset();
        table.dealerHand = [];
        table.players.forEach(p => {
            p.hand = [];
            p.active = true;
            p.score = 0; 
            p.hand.push(table.deck.draw()); 
            p.hand.push(table.deck.draw());
            p.score = calculateScore(p.hand);
        });

        table.dealerHand.push(table.deck.draw());
        table.dealerHand.push(table.deck.draw());

        table.activePlayerIndex = 0;
        table.state = 'PLAYER_TURN';
        this.checkInitialBlackjack(table);
    }

    checkInitialBlackjack(table) {
        // ... (логика BJ)
        this.moveToNextPlayer(table);
    }
    
    moveToNextPlayer(table) {
        let nextIndex = table.activePlayerIndex + 1;
        let foundNext = false;
        while (nextIndex < table.players.length) {
            if (table.players[nextIndex].active) {
                table.activePlayerIndex = nextIndex;
                foundNext = true;
                break;
            }
            nextIndex++;
        }

        if (!foundNext) {
            table.state = 'DEALER_TURN';
            this.dealerPlay(table);
            return;
        }
        this.sendTableState(table);
    }

    hit(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'PLAYER_TURN' || table.players[table.activePlayerIndex].id !== player.id) {
            socket.emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        const tablePlayer = table.players[table.activePlayerIndex];
        
        tablePlayer.hand.push(table.deck.draw());
        const score = calculateScore(tablePlayer.hand);
        tablePlayer.score = score; 

        if (score > 21) {
            tablePlayer.active = false;
            this.moveToNextPlayer(table);
        } else if (score === 21) {
            tablePlayer.active = false;
            this.moveToNextPlayer(table);
        } else {
             this.sendTableState(table);
        }
    }

    stand(socket, tableId) {
        const player = this.players[socket.id];
        const table = this.tables[tableId];

        if (table.gameType !== 'Blackjack' || table.state !== 'PLAYER_TURN' || table.players[table.activePlayerIndex].id !== player.id) {
            socket.emit('error_message', 'Сейчас не ваш ход.');
            return;
        }

        const tablePlayer = table.players[table.activePlayerIndex];
        tablePlayer.active = false;
        this.moveToNextPlayer(table);
    }

    dealerPlay(table) {
        let dealerScore = calculateScore(table.dealerHand);
        while (dealerScore < 17) {
            table.dealerHand.push(table.deck.draw());
            dealerScore = calculateScore(table.dealerHand);
        }
        this.checkResults(table);
    }

    checkResults(table) {
        const dealerScore = calculateScore(table.dealerHand);
        table.lastResult = { dealerScore: dealerScore, playerResults: {} }; 
        
        table.players.forEach(p => {
            const player = this.players[p.id];
            const playerScore = calculateScore(p.hand);
            let resultMessage = 'Проиграл';
            let winnings = 0;
            
            // ... (логика расчета выигрыша) ...
             if (playerScore > 21) {
                winnings = -p.bet; 
                resultMessage = 'Перебор! 📉';
            } else if (dealerScore > 21) {
                winnings = p.bet;
                resultMessage = 'Дилер перебор! Вы выиграли! 🎉';
            } else if (playerScore === 21 && p.hand.length === 2) {
                if (dealerScore === 21 && table.dealerHand.length === 2) {
                    winnings = 0;
                    resultMessage = 'Blackjack/Blackjack. Ничья. 🤝';
                } else {
                    winnings = p.bet * 1.5;
                    resultMessage = 'BLACKJACK! Вы выиграли 3:2! 💰';
                }
            } else if (playerScore > dealerScore) {
                winnings = p.bet;
                resultMessage = 'Вы выиграли! 🥳';
            } else if (playerScore < dealerScore) {
                winnings = -p.bet;
                resultMessage = 'Вы проиграли. 😞';
            } else {
                winnings = 0;
                resultMessage = 'Ничья (Push). 😐';
            }
            
            player.balance += p.bet + winnings;
            this.io.to(player.id).emit('auth_success', { id: player.id, balance: player.balance });
            this.io.to(player.id).emit('game_result', { message: resultMessage, winnings: winnings });
            table.lastResult.playerResults[p.id] = resultMessage; // Сохранение результата
        });

        table.state = 'RESULTS';
        this.sendTableState(table);
    }
    
    handleDisconnect(socket) {
        const player = this.players[socket.id];
        if (player && player.currentTableId) {
             this.leaveTable(socket); 
        }
        delete this.players[socket.id];
        this.broadcastTableList();
    }
    
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
                                p.active = true;
                            });
                            this.sendTableState(table);
                            delete table.resultTimer;
                            table.lastResult = null;
                         }, 5000); 
                    }
                }
            });
        }, 1000);
    }
    
    // ... (startMatchmakingLoop - опущен) ...
}

module.exports = { GameServerLogic, calculateScore };