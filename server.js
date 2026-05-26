const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Admin password
const ADMIN_PASSWORD = 'Dutch123!';

// --- Admin API ---
app.get('/admin/rooms', (req, res) => {
  const auth = req.query.password;
  if (auth !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

  const roomList = Object.entries(rooms).map(([id, room]) => ({
    id,
    phase: room.phase,
    playerCount: room.players.length,
    players: room.players.map(p => p.name),
    roundNumber: room.roundNumber,
    maxRounds: room.maxRounds,
    totalScores: room.totalScores,
  }));
  res.json(roomList);
});

app.post('/admin/rooms/:roomId/delete', express.json(), (req, res) => {
  const auth = req.query.password;
  if (auth !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Unauthorized' });

  const roomId = req.params.roomId;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });

  // Notify all players in the room
  for (const p of room.players) {
    io.to(p.socketId).emit('roomDeleted', { message: 'This room has been closed by an admin.' });
  }
  delete rooms[roomId];
  res.json({ success: true });
});

// --- Card & Deck helpers ---
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function isRed(suit) { return suit === 'hearts' || suit === 'diamonds'; }

function cardPoints(card) {
  if (card.value === 'A') return 1;
  if (card.value === 'K' && isRed(card.suit)) return 0;
  if (card.value === 'K') return 13;
  if (card.value === 'Q') return 12;
  if (card.value === 'J') return 11;
  return parseInt(card.value);
}

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ suit, value, id: `${value}_${suit}` });
    }
  }
  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// --- Game state ---
const rooms = {}; // roomId -> game state

function createRoom(roomId) {
  rooms[roomId] = {
    players: [],        // [{id, name, socketId, cards:[], peeked:false}]
    deck: [],
    discardPile: [],
    currentTurn: 0,
    phase: 'waiting',   // waiting, peeking, playing, dutchFinal, roundOver
    drawnCard: null,     // card drawn from deck (not yet placed)
    drawnFrom: null,     // 'deck' or 'discard'
    dutchCallerId: null,
    dutchCallerIndex: null,
    finalTurnsLeft: 0,
    finalTurnOrder: [],  // list of player indices who still get a turn
    roundScores: [],     // [{name, score}] per round
    totalScores: {},     // name -> total
    roundNumber: 0,
    maxRounds: 9,
    specialAction: null, // {type: 'peekJ' | 'swapQ', playerId}
    peekingPlayers: [],  // players who haven't finished peeking yet
    turnCompleted: false, // true after current player finishes their action
  };
  return rooms[roomId];
}

function getRoom(roomId) { return rooms[roomId]; }

function playerView(room, playerId) {
  // Return state visible to this player
  const pIdx = room.players.findIndex(p => p.id === playerId);
  const player = room.players[pIdx];

  const players = room.players.map((p, i) => ({
    id: p.id,
    name: p.name,
    cardCount: p.cards.length,
    cards: p.cards.map((c, ci) => {
      // During roundOver, show all
      if (room.phase === 'roundOver') return { ...c, faceUp: true };
      // Otherwise only show face-up cards or cards the player has peeked
      return { id: c.id, faceUp: false };
    }),
    isCurrentTurn: i === room.currentTurn,
  }));

  // Own cards with limited info
  const ownCards = player ? player.cards.map((c, ci) => ({
    ...c,
    faceUp: false,
  })) : [];

  return {
    phase: room.phase,
    players,
    ownCards,
    ownIndex: pIdx,
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    deckCount: room.deck.length,
    currentTurn: room.currentTurn,
    drawnCard: (room.drawnCard && room.players[room.currentTurn]?.id === playerId) ? room.drawnCard : null,
    drawnFrom: (room.drawnCard && room.players[room.currentTurn]?.id === playerId) ? room.drawnFrom : null,
    hasDrawnCard: room.drawnCard !== null,
    dutchCallerId: room.dutchCallerId,
    specialAction: room.specialAction,
    turnCompleted: room.turnCompleted,
    roundNumber: room.roundNumber,
    maxRounds: room.maxRounds,
    totalScores: room.totalScores,
    roundScores: room.roundScores,
  };
}

function broadcastState(room, roomId) {
  for (const p of room.players) {
    io.to(p.socketId).emit('gameState', playerView(room, p.id));
  }
}

function startRound(room, roomId) {
  room.deck = makeDeck();
  room.discardPile = [];
  room.drawnCard = null;
  room.drawnFrom = null;
  room.dutchCallerId = null;
  room.dutchCallerIndex = null;
  room.finalTurnsLeft = 0;
  room.finalTurnOrder = [];
  room.specialAction = null;
  room.roundNumber++;

  // Deal 4 cards to each player
  for (const p of room.players) {
    p.cards = [];
    for (let i = 0; i < 4; i++) {
      p.cards.push(room.deck.pop());
    }
    p.peeked = false;
  }

  // Flip first card to discard
  room.discardPile.push(room.deck.pop());

  // Peeking phase
  room.phase = 'peeking';
  room.peekingPlayers = room.players.map(p => p.id);

  broadcastState(room, roomId);
}

function nextTurn(room, roomId) {
  // After action completes, give player the chance to call dutch
  // unless we're already in dutchFinal phase
  if (room.phase === 'playing' && !room.turnCompleted) {
    room.turnCompleted = true;
    room.drawnCard = null;
    room.drawnFrom = null;
    broadcastState(room, roomId);
    return;
  }

  room.drawnCard = null;
  room.drawnFrom = null;
  room.turnCompleted = false;

  if (room.phase === 'dutchFinal') {
    if (room.finalTurnOrder.length === 0) {
      endRound(room, roomId);
      return;
    }
    room.currentTurn = room.finalTurnOrder.shift();
    // Skip players with no cards
    const cp = room.players[room.currentTurn];
    if (cp.cards.length === 0) {
      nextTurn(room, roomId);
      return;
    }
  } else {
    room.currentTurn = (room.currentTurn + 1) % room.players.length;
    // Skip players with no cards
    const cp = room.players[room.currentTurn];
    if (cp.cards.length === 0) {
      // This player emptied their hand -> trigger dutch
      triggerDutch(room, roomId, cp.id);
      return;
    }
  }

  broadcastState(room, roomId);
}

function triggerDutch(room, roomId, playerId) {
  const pIdx = room.players.findIndex(p => p.id === playerId);
  room.dutchCallerId = playerId;
  room.dutchCallerIndex = pIdx;
  room.phase = 'dutchFinal';

  io.to(roomId).emit('actionEvent', {
    type: 'dutch', playerId, playerName: room.players[pIdx].name
  });

  // Build final turn order: everyone after dutchCaller gets one more turn
  room.finalTurnOrder = [];
  for (let i = 1; i < room.players.length; i++) {
    const idx = (pIdx + i) % room.players.length;
    if (room.players[idx].cards.length > 0) {
      room.finalTurnOrder.push(idx);
    }
  }

  if (room.finalTurnOrder.length === 0) {
    endRound(room, roomId);
    return;
  }

  room.currentTurn = room.finalTurnOrder.shift();
  broadcastState(room, roomId);
}

function endRound(room, roomId) {
  room.phase = 'roundOver';
  const scores = [];
  for (const p of room.players) {
    let s = 0;
    for (const c of p.cards) {
      s += cardPoints(c);
    }
    scores.push({ name: p.name, id: p.id, score: s });
    room.totalScores[p.name] = (room.totalScores[p.name] || 0) + s;
  }

  // Tiebreaker: if two have same total at end, the one furthest clockwise from dutch caller wins
  room.roundScores = scores;
  broadcastState(room, roomId);
}

function isSpecialDiscard(card) {
  // Red J = peek, Red Q = swap
  if (card.value === 'J' && isRed(card.suit)) return 'peekJ';
  if (card.value === 'Q' && isRed(card.suit)) return 'swapQ';
  return null;
}

// --- Socket.IO ---
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  socket.on('joinRoom', ({ roomId, playerName }) => {
    currentRoom = roomId;
    playerId = socket.id;

    let room = getRoom(roomId);
    if (!room) {
      room = createRoom(roomId);
    }

    // Check if reconnecting
    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
      existing.socketId = socket.id;
      existing.id = socket.id;
      playerId = socket.id;
    } else if (room.phase === 'waiting') {
      room.players.push({
        id: socket.id,
        name: playerName,
        socketId: socket.id,
        cards: [],
        peeked: false,
      });
    } else {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }

    socket.join(roomId);
    io.to(roomId).emit('roomUpdate', {
      players: room.players.map(p => p.name),
      phase: room.phase,
    });
    broadcastState(room, roomId);
  });

  socket.on('startGame', () => {
    const room = getRoom(currentRoom);
    if (!room || room.players.length < 2) return;
    room.totalScores = {};
    room.roundNumber = 0;
    for (const p of room.players) {
      room.totalScores[p.name] = 0;
    }
    startRound(room, currentRoom);
  });

  socket.on('peekDone', ({ cardIndices }) => {
    // Player has chosen 2 cards to peek at during peeking phase
    const room = getRoom(currentRoom);
    if (!room || room.phase !== 'peeking') return;

    const pIdx = room.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return;
    const player = room.players[pIdx];

    if (player.peeked) return;
    if (!cardIndices || cardIndices.length !== 2) return;

    // Send peeked cards to this player only
    const peekedCards = cardIndices.map(i => ({ index: i, ...player.cards[i] }));
    socket.emit('peekedCards', peekedCards);

    player.peeked = true;
    room.peekingPlayers = room.peekingPlayers.filter(id => id !== playerId);

    if (room.peekingPlayers.length === 0) {
      room.phase = 'playing';
      room.currentTurn = 0;
      broadcastState(room, currentRoom);
    }
  });

  socket.on('drawCard', ({ source }) => {
    const room = getRoom(currentRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'dutchFinal')) return;
    if (room.players[room.currentTurn]?.id !== playerId) return;
    if (room.drawnCard) return; // already drew
    if (room.specialAction) return;
    if (room.turnCompleted) return;

    const player = room.players[room.currentTurn];

    if (source === 'deck') {
      if (room.deck.length === 0) return;
      room.drawnCard = room.deck.pop();
      room.drawnFrom = 'deck';
      io.to(currentRoom).emit('actionEvent', {
        type: 'draw', source: 'deck', playerId, playerName: player.name
      });
    } else if (source === 'discard') {
      if (room.discardPile.length === 0) return;
      const drawnDiscard = room.discardPile[room.discardPile.length - 1];
      room.drawnCard = room.discardPile.pop();
      room.drawnFrom = 'discard';
      io.to(currentRoom).emit('actionEvent', {
        type: 'draw', source: 'discard', playerId, playerName: player.name,
        card: drawnDiscard
      });
    }

    broadcastState(room, currentRoom);
  });

  socket.on('placeCard', ({ cardIndex }) => {
    // Swap drawn card with one in hand
    const room = getRoom(currentRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'dutchFinal')) return;
    if (room.players[room.currentTurn]?.id !== playerId) return;
    if (!room.drawnCard) return;
    if (room.specialAction) return;

    const player = room.players[room.currentTurn];
    if (cardIndex < 0 || cardIndex >= player.cards.length) return;

    const oldCard = player.cards[cardIndex];
    const newCard = room.drawnCard;
    player.cards[cardIndex] = newCard;
    room.discardPile.push(oldCard);
    room.drawnCard = null;
    room.drawnFrom = null;

    // Broadcast: player placed card at position X, discarded Y
    io.to(currentRoom).emit('actionEvent', {
      type: 'place', playerId, playerName: player.name,
      cardIndex, discardedCard: oldCard
    });

    // Check for special card action
    const special = isSpecialDiscard(oldCard);
    if (special) {
      room.specialAction = { type: special, playerId };
      broadcastState(room, currentRoom);
      return;
    }

    nextTurn(room, currentRoom);
  });

  socket.on('discardDrawn', () => {
    // Discard the drawn card without swapping (only from deck)
    const room = getRoom(currentRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'dutchFinal')) return;
    if (room.players[room.currentTurn]?.id !== playerId) return;
    if (!room.drawnCard) return;
    if (room.drawnFrom !== 'deck') return;
    if (room.specialAction) return;

    const player = room.players[room.currentTurn];
    const discarded = room.drawnCard;
    room.discardPile.push(discarded);
    room.drawnCard = null;
    room.drawnFrom = null;

    io.to(currentRoom).emit('actionEvent', {
      type: 'discardDrawn', playerId, playerName: player.name,
      discardedCard: discarded
    });

    // Check for special card action
    const special = isSpecialDiscard(discarded);
    if (special) {
      room.specialAction = { type: special, playerId };
      broadcastState(room, currentRoom);
      return;
    }

    nextTurn(room, currentRoom);
  });

  socket.on('specialPeek', ({ targetPlayerId, cardIndex }) => {
    // Red J action: peek at any one card
    const room = getRoom(currentRoom);
    if (!room || !room.specialAction || room.specialAction.type !== 'peekJ') return;
    if (room.specialAction.playerId !== playerId) return;

    const targetPlayer = room.players.find(p => p.id === targetPlayerId);
    if (!targetPlayer) return;
    if (cardIndex < 0 || cardIndex >= targetPlayer.cards.length) return;

    const card = targetPlayer.cards[cardIndex];
    socket.emit('peekedCards', [{ index: cardIndex, ...card, ownerId: targetPlayerId }]);

    room.specialAction = null;
    nextTurn(room, currentRoom);
  });

  socket.on('specialSwap', ({ player1Id, card1Index, player2Id, card2Index }) => {
    // Red Q action: swap two cards between players
    const room = getRoom(currentRoom);
    if (!room || !room.specialAction || room.specialAction.type !== 'swapQ') return;
    if (room.specialAction.playerId !== playerId) return;

    const p1 = room.players.find(p => p.id === player1Id);
    const p2 = room.players.find(p => p.id === player2Id);
    if (!p1 || !p2) return;
    if (card1Index < 0 || card1Index >= p1.cards.length) return;
    if (card2Index < 0 || card2Index >= p2.cards.length) return;
    // At least one must be different from the acting player? No - rules say swap own with other or other with other
    // But one of them must involve another player (can't swap two of your own)
    if (player1Id === player2Id) return;

    const temp = p1.cards[card1Index];
    p1.cards[card1Index] = p2.cards[card2Index];
    p2.cards[card2Index] = temp;

    io.to(currentRoom).emit('actionEvent', {
      type: 'swap', playerId,
      playerName: room.players.find(p => p.id === playerId).name,
      player1Name: p1.name, player1Id: player1Id, card1Index,
      player2Name: p2.name, player2Id: player2Id, card2Index
    });

    room.specialAction = null;
    nextTurn(room, currentRoom);
  });

  socket.on('skipSpecial', () => {
    const room = getRoom(currentRoom);
    if (!room || !room.specialAction) return;
    if (room.specialAction.playerId !== playerId) return;
    room.specialAction = null;
    nextTurn(room, currentRoom);
  });

  socket.on('slapCard', ({ cardIndex }) => {
    // Out-of-turn discard: player thinks their card matches discard top value
    const room = getRoom(currentRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'dutchFinal')) return;
    if (room.specialAction) return;
    // Don't allow during card draw
    if (room.drawnCard) return;

    const pIdx = room.players.findIndex(p => p.id === playerId);
    if (pIdx === -1) return;
    const player = room.players[pIdx];
    if (cardIndex < 0 || cardIndex >= player.cards.length) return;

    const topDiscard = room.discardPile[room.discardPile.length - 1];
    if (!topDiscard) return;

    const card = player.cards[cardIndex];

    if (card.value === topDiscard.value) {
      // Correct! Remove card from hand and put on discard
      player.cards.splice(cardIndex, 1);
      room.discardPile.push(card);

      // Check special
      const special = isSpecialDiscard(card);
      if (special) {
        room.specialAction = { type: special, playerId };
        broadcastState(room, currentRoom);
        // After special resolves, check if player has no cards
        return;
      }

      // Check if player has no cards left -> triggers dutch
      if (player.cards.length === 0 && room.phase !== 'dutchFinal') {
        broadcastState(room, currentRoom);
        triggerDutch(room, currentRoom, playerId);
        return;
      }

      io.to(currentRoom).emit('slapResult', { success: true, playerId, playerName: player.name, card });
      broadcastState(room, currentRoom);
    } else {
      // Wrong! Penalty: draw a card from deck
      if (room.deck.length > 0) {
        const penalty = room.deck.pop();
        player.cards.push(penalty);
        io.to(currentRoom).emit('slapResult', { success: false, playerId, playerName: player.name, card });
        broadcastState(room, currentRoom);
      }
    }
  });

  socket.on('callDutch', () => {
    const room = getRoom(currentRoom);
    if (!room || room.phase !== 'playing') return;
    if (room.players[room.currentTurn]?.id !== playerId) return;
    // Player must have completed their action first
    if (!room.turnCompleted) return;
    if (room.specialAction) return;

    room.turnCompleted = false;
    triggerDutch(room, currentRoom, playerId);
  });

  socket.on('endTurn', () => {
    const room = getRoom(currentRoom);
    if (!room || (room.phase !== 'playing' && room.phase !== 'dutchFinal')) return;
    if (room.players[room.currentTurn]?.id !== playerId) return;
    if (!room.turnCompleted) return;
    if (room.specialAction) return;

    nextTurn(room, currentRoom);
  });

  socket.on('nextRound', () => {
    const room = getRoom(currentRoom);
    if (!room || room.phase !== 'roundOver') return;
    if (room.roundNumber >= room.maxRounds) {
      room.phase = 'gameOver';
      broadcastState(room, currentRoom);
      return;
    }
    startRound(room, currentRoom);
  });

  socket.on('disconnect', () => {
    // Keep player in room for reconnection
  });
});

server.listen(3000, () => {
  console.log('Dutch card game running on port 3000');
});
