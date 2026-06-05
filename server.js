// =============================================================
// MADAME FAFI — server.js TOUT-EN-UN
// Contient : DB, auth, toutes les routes, email, helpers
// =============================================================
require('dotenv').config();

const express  = require('express');
const path     = require('path');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Pool } = require('pg');
const compression   = require('compression');
const helmet        = require('helmet');
const rateLimit     = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIG ───────────────────────────────────────────────────
const JWT_SECRET       = process.env.JWT_SECRET       || 'madamefafi-jwt-secret-change-me';
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'madamefafi-admin-secret-change-me';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'admin-change-me';
const REVIEW_LINK      = process.env.REVIEW_LINK      || 'https://www.google.com/search?q=Madame+Fafi+avis';

// ─── DATABASE ─────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is required');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

// ─── CREDIT PACKS ─────────────────────────────────────────────
const CREDIT_PACKS = {
  '5':  { id: '5',  name: '5 Tirages',  credits: 5,  amountCents: 499,  priceEur: 4.99  },
  '15': { id: '15', name: '15 Tirages', credits: 15, amountCents: 1299, priceEur: 12.99 },
  '30': { id: '30', name: '30 Tirages', credits: 30, amountCents: 1999, priceEur: 19.99 },
  '60': { id: '60', name: '60 Tirages', credits: 60, amountCents: 3499, priceEur: 34.99 },
};

// ─── AUTH HELPERS ─────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch { return res.status(401).json({ error: 'Token invalide' }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non autorisé' });
  try {
    const decoded = jwt.verify(token, ADMIN_JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ error: 'Accès refusé' });
    next();
  } catch { return res.status(401).json({ error: 'Token admin invalide' }); }
}

// ─── EMAIL ────────────────────────────────────────────────────
async function sendWelcomeEmail(username, email) {
  try {
    const subject = '✨ Bienvenue chez Madame Fafi !';
    const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;background:#0f0518;color:#fff;padding:32px;border-radius:12px;"><h1 style="color:#d946a6;">Bienvenue, ${username} ✨</h1><p style="color:#e2d9f3;">Vous avez <strong style="color:#a78bfa;">1 crédit gratuit</strong> chaque jour pour consulter les cartes.</p><a href="https://madame-fafi-6w0y.onrender.com/app" style="display:inline-block;background:linear-gradient(135deg,#d946a6,#7c3aed);color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;margin-top:16px;">Commencer mon tirage 🔮</a></div>`;

    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const nodemailer = require('nodemailer');
      const t = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: parseInt(process.env.SMTP_PORT) === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await t.sendMail({ from: '"Madame Fafi ✨" <contact@madamefafi.com>', to: email, subject, html });
      console.log(`[EMAIL] Welcome sent to ${email}`);
    }
  } catch (err) {
    console.warn('[EMAIL] Welcome email failed:', err.message);
  }
}

// ─── REFERRAL HELPERS ─────────────────────────────────────────
function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function assignReferralCode(userId) {
  for (let i = 0; i < 5; i++) {
    const code = generateReferralCode();
    try {
      const r = await pool.query(
        'UPDATE users SET referral_code=$1 WHERE id=$2 AND referral_code IS NULL RETURNING referral_code',
        [code, userId]
      );
      if (r.rows.length > 0) return r.rows[0].referral_code;
    } catch (e) { if (e.code !== '23505') throw e; }
  }
}

async function creditReferrerForFirstDraw(referredUserId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ref = await client.query(
      'SELECT id,referrer_id FROM referrals WHERE referred_id=$1 AND credited=FALSE FOR UPDATE',
      [referredUserId]
    );
    if (!ref.rows.length) { await client.query('ROLLBACK'); return; }
    const { id: refId, referrer_id: referrerId } = ref.rows[0];
    const cap = await client.query(
      `SELECT COUNT(*) AS n FROM referrals WHERE referrer_id=$1 AND credited=TRUE AND created_at>=DATE_TRUNC('month',NOW())`,
      [referrerId]
    );
    if (parseInt(cap.rows[0].n) >= 10) {
      await client.query("UPDATE referrals SET credited=TRUE,status='cap_reached' WHERE id=$1", [refId]);
    } else {
      await client.query('UPDATE users SET credits=credits+1 WHERE id=$1', [referrerId]);
      await client.query("UPDATE referrals SET credited=TRUE,status='credited' WHERE id=$1", [refId]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); } finally { client.release(); }
}

// ─── CARD HELPERS ─────────────────────────────────────────────
const DAILY_CREDIT_MODES = ['oracle', 'tarot'];
const VALID_MODES = ['oracle', 'tarot', 'amour', 'travail', 'horoscope', 'question'];

function isDailyCreditAvailable(userRow) {
  if (!userRow.daily_credit_used_at) return true;
  const opts = { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' };
  return new Date(userRow.daily_credit_used_at).toLocaleDateString('fr-FR', opts) !==
         new Date().toLocaleDateString('fr-FR', opts);
}

function isSundayParis() {
  return new Intl.DateTimeFormat('en-US',{ timeZone:'Europe/Paris', weekday:'short' }).format(new Date()) === 'Sun';
}

function getDiceState(u) {
  let hasRolled = false;
  if (u.dice_roll_used_at) {
    const toStr = d => new Intl.DateTimeFormat('sv-SE',{ timeZone:'Europe/Paris' }).format(d);
    const now = new Date(), ms = 86400000;
    const nowD = new Date(toStr(now)+'T00:00:00Z');
    const rollD = new Date(toStr(new Date(u.dice_roll_used_at))+'T00:00:00Z');
    hasRolled = rollD.getTime() >= nowD.getTime() - nowD.getUTCDay()*ms;
  }
  const isSun = isSundayParis();
  return { is_sunday:isSun, has_rolled_this_week:hasRolled,
    dice_roll_result: hasRolled?(u.dice_roll_result||null):null,
    dice_draws_remaining: hasRolled?(u.dice_draws_remaining||0):0,
    can_roll: isSun&&!hasRolled };
}

const ORACLE_CARDS = [
  { id:1,name:'La Lumière',emoji:'✨',meaning:'Clarté, révélation, vérité' },
  { id:2,name:'La Lune',emoji:'🌙',meaning:'Intuition, mystère, rêves' },
  { id:3,name:'Le Soleil',emoji:'☀️',meaning:'Joie, réussite, énergie' },
  { id:4,name:"L'Étoile",emoji:'⭐',meaning:'Espoir, inspiration, guidance' },
  { id:5,name:'Le Phénix',emoji:'🔥',meaning:'Renaissance, transformation' },
  { id:6,name:"L'Océan",emoji:'🌊',meaning:'Émotions profondes, flux' },
  { id:7,name:'La Rose',emoji:'🌹',meaning:'Amour, beauté, passion' },
  { id:8,name:'Le Miroir',emoji:'🪞',meaning:'Réflexion, vérité intérieure' },
  { id:9,name:'La Clé',emoji:'🗝️',meaning:'Ouverture, solution, secret' },
  { id:10,name:'Le Papillon',emoji:'🦋',meaning:'Métamorphose, liberté' },
  { id:11,name:'La Couronne',emoji:'👑',meaning:'Pouvoir, accomplissement' },
  { id:12,name:'Le Serpent',emoji:'🐍',meaning:'Sagesse, guérison, renouveau' },
  { id:13,name:'La Montagne',emoji:'🏔️',meaning:'Obstacle, persévérance, sommet' },
  { id:14,name:'Le Sablier',emoji:'⏳',meaning:'Temps, patience, cycles' },
  { id:15,name:"L'Ange",emoji:'👼',meaning:'Protection, message divin' },
  { id:16,name:'Le Lotus',emoji:'🪷',meaning:'Éveil spirituel, pureté' },
  { id:17,name:'Le Corbeau',emoji:'🐦‍⬛',meaning:'Présage, magie, transformation' },
  { id:18,name:'La Fontaine',emoji:'⛲',meaning:'Abondance, émotion, source' },
  { id:19,name:'Le Cristal',emoji:'💎',meaning:'Clarté, énergie, protection' },
  { id:20,name:"L'Arbre",emoji:'🌳',meaning:'Racines, croissance, stabilité' },
  { id:21,name:'La Flamme',emoji:'🕯️',meaning:'Passion, illumination, purification' },
  { id:22,name:'Le Vent',emoji:'🌬️',meaning:'Changement, mouvement, souffle' },
];
const TAROT_CARDS = [
  { id:1,name:'Le Mat',emoji:'🃏',meaning:'Liberté, aventure, nouveau départ' },
  { id:2,name:'Le Bateleur',emoji:'🎩',meaning:'Habileté, initiative, création' },
  { id:3,name:'La Papesse',emoji:'📜',meaning:'Sagesse cachée, patience, intuition' },
  { id:4,name:"L'Impératrice",emoji:'👸',meaning:'Fertilité, abondance, nature' },
  { id:5,name:"L'Empereur",emoji:'🏛️',meaning:'Autorité, structure, stabilité' },
  { id:6,name:'Le Pape',emoji:'🔑',meaning:'Enseignement, tradition, bienveillance' },
  { id:7,name:"L'Amoureux",emoji:'💘',meaning:'Choix, union, harmonie' },
  { id:8,name:'Le Chariot',emoji:'⚔️',meaning:'Victoire, volonté, conquête' },
  { id:9,name:'La Justice',emoji:'⚖️',meaning:'Équilibre, vérité, décision' },
  { id:10,name:"L'Hermite",emoji:'🏮',meaning:'Introspection, solitude, guidance' },
  { id:11,name:'La Roue de Fortune',emoji:'🎡',meaning:'Cycles, destin, opportunité' },
  { id:12,name:'La Force',emoji:'🦁',meaning:'Courage, maîtrise, détermination' },
  { id:13,name:'Le Pendu',emoji:'🔄',meaning:'Sacrifice, lâcher-prise, vision' },
  { id:14,name:'La Mort',emoji:'🦅',meaning:'Transformation, fin, renouveau' },
  { id:15,name:'Tempérance',emoji:'🏺',meaning:'Équilibre, patience, guérison' },
  { id:16,name:'Le Diable',emoji:'⛓️',meaning:'Tentation, attachement, libération' },
  { id:17,name:'La Maison Dieu',emoji:'⚡',meaning:'Révélation, changement brutal, vérité' },
  { id:18,name:"L'Étoile",emoji:'🌟',meaning:'Espoir, sérénité, inspiration' },
  { id:19,name:'La Lune',emoji:'🌕',meaning:'Illusions, inconscient, mystère' },
  { id:20,name:'Le Soleil',emoji:'🌞',meaning:'Bonheur, succès, vitalité' },
  { id:21,name:'Le Jugement',emoji:'📯',meaning:'Renaissance, appel, élévation' },
  { id:22,name:'Le Monde',emoji:'🌍',meaning:'Accomplissement, plénitude, harmonie' },
];
const AMOUR_CARDS = [
  { id:1,name:'La Flamme Jumelle',emoji:'🔥',meaning:'Connexion intense, âme sœur' },
  { id:2,name:'Le Baiser',emoji:'💋',meaning:'Passion, désir, rapprochement' },
  { id:3,name:'Les Cœurs Unis',emoji:'💕',meaning:'Union, engagement, fidélité' },
  { id:4,name:"La Lettre d'Amour",emoji:'💌',meaning:'Déclaration, message, surprise' },
  { id:5,name:'Le Jardin Secret',emoji:'🌺',meaning:'Intimité, confiance, partage' },
  { id:6,name:"L'Éclipse",emoji:'🌑',meaning:'Distance, doutes, test du couple' },
  { id:7,name:'La Danse',emoji:'💃',meaning:'Séduction, rencontre, attraction' },
  { id:8,name:'Le Nœud',emoji:'🎀',meaning:'Liens, engagement, promesse' },
  { id:9,name:'Le Cygne',emoji:'🦢',meaning:'Grâce, fidélité éternelle, élégance' },
  { id:10,name:'La Perle',emoji:'🫧',meaning:'Beauté intérieure, valeur, rareté' },
  { id:11,name:'Le Philtre',emoji:'🧪',meaning:'Charme, magnétisme, alchimie' },
  { id:12,name:'La Pleine Lune',emoji:'🌕',meaning:'Romantisme, émotions, révélation' },
  { id:13,name:'Les Cerises',emoji:'🍒',meaning:'Plaisir, complicité, douceur' },
  { id:14,name:"La Clé du Cœur",emoji:'💝',meaning:'Ouverture, vulnérabilité, confiance' },
  { id:15,name:"L'Arc de Cupidon",emoji:'🏹',meaning:'Coup de foudre, destin amoureux' },
  { id:16,name:"Le Miroir d'Âme",emoji:'🪞',meaning:'Réflexion, amour de soi, vérité' },
  { id:17,name:'La Tempête',emoji:'⛈️',meaning:'Crise, passion destructrice, épreuve' },
  { id:18,name:'Le Soleil Levant',emoji:'🌅',meaning:'Nouveau départ, réconciliation, espoir' },
  { id:19,name:"L'Alliance",emoji:'💍',meaning:'Mariage, engagement, union sacrée' },
  { id:20,name:'La Colombe',emoji:'🕊️',meaning:'Paix, pardon, harmonie retrouvée' },
  { id:21,name:'Le Feu Sacré',emoji:'🕯️',meaning:'Passion durable, dévotion, ardeur' },
  { id:22,name:"L'Étoile du Soir",emoji:'🌠',meaning:'Destinée amoureuse, vœux, magie' },
];
const TRAVAIL_CARDS = [
  { id:1,name:"L'Ascension",emoji:'🚀',meaning:'Promotion, élévation, succès fulgurant' },
  { id:2,name:'Le Bâtisseur',emoji:'🏗️',meaning:'Création, fondations, projet solide' },
  { id:3,name:'La Boussole',emoji:'🧭',meaning:'Direction, choix de carrière, orientation' },
  { id:4,name:'Le Trésor',emoji:'💰',meaning:'Richesse, récompense, prospérité' },
  { id:5,name:"L'Enclume",emoji:'⚒️',meaning:'Travail acharné, persévérance, forge' },
  { id:6,name:'Le Phare',emoji:'🗼',meaning:'Leadership, vision, inspiration' },
  { id:7,name:'Le Labyrinthe',emoji:'🌀',meaning:'Complexité, défi, solution cachée' },
  { id:8,name:"La Balance d'Or",emoji:'⚖️',meaning:'Négociation, justice, équilibre pro' },
  { id:9,name:'Le Semeur',emoji:'🌱',meaning:'Investissement, patience, croissance' },
  { id:10,name:"L'Aigle",emoji:'🦅',meaning:'Vision, ambition, perspective élevée' },
  { id:11,name:"Le Sablier d'Or",emoji:'⏳',meaning:'Timing, deadline, moment opportun' },
  { id:12,name:'Le Parchemin',emoji:'📋',meaning:'Contrat, accord, engagement pro' },
  { id:13,name:'La Porte',emoji:'🚪',meaning:'Opportunité, changement, nouveau poste' },
  { id:14,name:'Le Bouclier',emoji:'🛡️',meaning:'Protection, sécurité, stabilité' },
  { id:15,name:'La Forge',emoji:'🔥',meaning:'Transformation, compétences, maîtrise' },
  { id:16,name:'Le Réseau',emoji:'🕸️',meaning:'Connexions, collaboration, alliance' },
  { id:17,name:'La Couronne de Laurier',emoji:'🏆',meaning:'Victoire, reconnaissance, honneur' },
  { id:18,name:'Le Pont',emoji:'🌉',meaning:'Transition, passage, évolution' },
  { id:19,name:"L'Échiquier",emoji:'♟️',meaning:'Stratégie, calcul, planification' },
  { id:20,name:'La Récolte',emoji:'🌾',meaning:'Fruits du travail, abondance méritée' },
  { id:21,name:'Le Diamant Brut',emoji:'💎',meaning:'Potentiel, talent caché, valeur' },
  { id:22,name:"L'Horizon",emoji:'🌄',meaning:'Avenir, possibilités, ouverture' },
];
const QUESTION_CARDS = [
  { id:1,name:'La Réponse Divine',emoji:'🙏',meaning:"Réponse directe de l'au-delà" },
  { id:2,name:'Le Signe Céleste',emoji:'✨',meaning:'Confirmation, signal du destin' },
  { id:3,name:'Le Voile Levé',emoji:'🌫️',meaning:'Révélation, vérité cachée dévoilée' },
  { id:4,name:"L'Œil Qui Voit",emoji:'👁️',meaning:'Clairvoyance, ce qui est caché' },
  { id:5,name:'La Flamme Éternelle',emoji:'🕯️',meaning:"Lumière dans l'obscurité, guidance" },
  { id:6,name:'La Vérité Nue',emoji:'⚡',meaning:'Réalité brutale, clarté absolue' },
  { id:7,name:"L'Écho de l'Âme",emoji:'🔔',meaning:'Résonance intérieure, intuition' },
  { id:8,name:'La Porte Secrète',emoji:'🚪',meaning:'Passage, ouverture, seuil à franchir' },
  { id:9,name:'Le Messager Céleste',emoji:'🕊️',meaning:"Message de l'au-delà, signe" },
  { id:10,name:"L'Instant Décisif",emoji:'⏰',meaning:'Timing parfait, moment charnière' },
  { id:11,name:'Le Destin Scellé',emoji:'🌟',meaning:'Ce qui doit être, inévitable' },
  { id:12,name:'La Bénédiction',emoji:'🌸',meaning:'Grâce divine, protection, faveur' },
  { id:13,name:"L'Avertissement",emoji:'🌑',meaning:'Mise en garde, danger, attention' },
  { id:14,name:'Le Retournement',emoji:'🔄',meaning:'Inversion, surprise, renversement' },
  { id:15,name:"L'Accord Cosmique",emoji:'🌌',meaning:'Alignement, synchronicité, harmonie' },
  { id:16,name:'Le Bouclier Divin',emoji:'🛡️',meaning:'Protection céleste, résistance' },
  { id:17,name:'La Clé Dorée',emoji:'🗝️',meaning:'Solution, accès, déblocage' },
  { id:18,name:'Le Lâcher-Prise',emoji:'🍃',meaning:'Acceptation, abandon nécessaire' },
  { id:19,name:'La Confiance Absolue',emoji:'💫',meaning:'Foi, certitude, abandon au divin' },
  { id:20,name:"L'Illusion Brisée",emoji:'🪞',meaning:'Désillusion, réalité, mensonge révélé' },
  { id:21,name:'Le Nouveau Souffle',emoji:'🌬️',meaning:'Renouveau, départ, renaissance' },
  { id:22,name:"L'Accomplissement",emoji:'🏆',meaning:'Victoire, réalisation, aboutissement' },
];
const ZODIAC_SIGNS = {
  belier:{id:'belier',name:'Bélier',emoji:'♈',meaning:'21 mars – 19 avr.',traits:'courage, passion, initiative'},
  taureau:{id:'taureau',name:'Taureau',emoji:'♉',meaning:'20 avr. – 20 mai',traits:'sensualité, patience, stabilité'},
  gemeaux:{id:'gemeaux',name:'Gémeaux',emoji:'♊',meaning:'21 mai – 20 juin',traits:'curiosité, communication, adaptabilité'},
  cancer:{id:'cancer',name:'Cancer',emoji:'♋',meaning:'21 juin – 22 juil.',traits:'sensibilité, intuition, famille'},
  lion:{id:'lion',name:'Lion',emoji:'♌',meaning:'23 juil. – 22 août',traits:'fierté, créativité, générosité'},
  vierge:{id:'vierge',name:'Vierge',emoji:'♍',meaning:'23 août – 22 sept.',traits:'précision, dévotion, analyse'},
  balance:{id:'balance',name:'Balance',emoji:'♎',meaning:'23 sept. – 22 oct.',traits:'harmonie, justice, beauté'},
  scorpion:{id:'scorpion',name:'Scorpion',emoji:'♏',meaning:'23 oct. – 21 nov.',traits:'intensité, mystère, transformation'},
  sagittaire:{id:'sagittaire',name:'Sagittaire',emoji:'♐',meaning:'22 nov. – 21 déc.',traits:'liberté, optimisme, philosophie'},
  capricorne:{id:'capricorne',name:'Capricorne',emoji:'♑',meaning:'22 déc. – 19 jan.',traits:'ambition, discipline, persévérance'},
  verseau:{id:'verseau',name:'Verseau',emoji:'♒',meaning:'20 jan. – 18 févr.',traits:'originalité, humanisme, liberté'},
  poissons:{id:'poissons',name:'Poissons',emoji:'♓',meaning:'19 févr. – 20 mars',traits:'empathie, spiritualité, rêverie'},
};

const DECK_MAP = { oracle:ORACLE_CARDS, tarot:TAROT_CARDS, amour:AMOUR_CARDS, travail:TRAVAIL_CARDS, question:QUESTION_CARDS };

const MODE_PROMPTS = {
  oracle: {
    system:"Tu es Madame Fafi, voyante connue sur TikTok. Tu parles en français, ton chaleureux et mystique, tutoies toujours. Ta réponse est UNE SEULE PHRASE courte et percutante. Tu ne mentionnes jamais que tu es une IA. Français parfait, zéro faute.",
    user:(c)=>`Les cartes tirées sont : ${c}. Donne UNE SEULE PHRASE de prédiction mystique, en tutoyant.`,
    fallback:(c)=>`Mon cœur, les cartes ${c} te soufflent que les énergies bougent autour de toi — fais confiance à ce qui vient.`,
  },
  tarot: {
    system:"Tu es Madame Fafi, tarologue reconnue sur TikTok. Tirage tarot classique. Français chaleureux et mystique, tutoies toujours. UNE SEULE PHRASE. Jamais de mention IA. Français parfait.",
    user:(c)=>`Les arcanes tirés sont : ${c}. UNE SEULE PHRASE d'interprétation profonde et mystique, en tutoyant.`,
    fallback:(c)=>`Mon cœur, les arcanes ${c} murmurent que ta destinée se réécrît — écoute leur vérité.`,
  },
  amour: {
    system:"Tu es Madame Fafi, voyante spécialisée en amour. Français romantique et mystique, tutoies toujours. UNE SEULE PHRASE poétique. Jamais de mention IA. Français parfait.",
    user:(c)=>`Les cartes d'amour tirées sont : ${c}. UNE SEULE PHRASE sur l'amour, poétique et touchante, en tutoyant.`,
    fallback:(c)=>`Mon cœur, les cartes d'amour ${c} soufflent que quelque chose de puissant se prépare pour ton cœur.`,
  },
  travail: {
    system:"Tu es Madame Fafi, voyante spécialisée en carrière. Français motivant et mystique, tutoies toujours. UNE SEULE PHRASE directe. Jamais de mention IA. Français parfait.",
    user:(c)=>`Les cartes de travail tirées sont : ${c}. UNE SEULE PHRASE sur la carrière, directe et motivante, en tutoyant.`,
    fallback:(c)=>`Mon cœur, les cartes ${c} montrent que le moment d'oser est maintenant — avance avec confiance.`,
  },
  horoscope: {
    system:"Tu es Madame Fafi, astrologue connue sur TikTok. Horoscope du jour. Français chaleureux et mystique, tutoies toujours. UNE SEULE PHRASE percutante. Jamais de mention IA. Français parfait.",
    user:(s)=>`Signe : ${s}. UNE SEULE PHRASE d'horoscope du jour, mystique et percutante, en tutoyant.`,
    fallback:(s)=>`Mon cœur, les étoiles du ${s} te soufflent que quelque chose de puissant s'approche — garde le cœur grand ouvert.`,
  },
  question: {
    system:"Tu es Madame Fafi, médium connue sur TikTok. Tu canalises des messages pour répondre aux questions. Français mystique, tutoies toujours. UNE SEULE PHRASE cryptique. Jamais de mention IA. Français parfait.",
    user:(q,c)=>`Question : "${q}". Carte : ${c}. UNE SEULE PHRASE mystique et cryptique comme un message de l'au-delà, en tutoyant.`,
    fallback:()=>`Mon cœur, les forces de l'au-delà entendent ta question — la réponse est déjà en toi.`,
  },
};

function drawCards(mode, count=3) {
  const deck = DECK_MAP[mode] || ORACLE_CARDS;
  return [...deck].sort(()=>Math.random()-0.5).slice(0,count);
}

// ─── EXPRESS SETUP ────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', rateLimit({ windowMs: 15*60*1000, max: 200 }));

// ─── HEALTH ───────────────────────────────────────────────────
app.get('/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', db:'connected' }); }
  catch(e) { res.status(500).json({ status:'error', db:e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/signup', async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, email, password, ref, signup_source } = req.body;
    if (!username?.trim() || username.trim().length < 2)
      return res.status(400).json({ error: 'Prénom requis (min 2 caractères)' });
    if (!email?.includes('@'))
      return res.status(400).json({ error: 'Email invalide' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Mot de passe requis (min 6 caractères)' });

    const trimEmail = email.trim().toLowerCase();
    const trimName  = username.trim();
    const existing  = await client.query('SELECT id FROM users WHERE LOWER(email)=$1', [trimEmail]);
    if (existing.rows.length) return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hash = await bcrypt.hash(password, 10);
    await client.query('BEGIN');

    const r = await client.query(
      `INSERT INTO users (username,email,password_hash,credits,signup_source,created_at)
       VALUES ($1,$2,$3,1,$4,NOW()) RETURNING id,username,email,credits,is_unlimited,is_admin`,
      [trimName, trimEmail, hash, signup_source||'direct']
    );
    const user = r.rows[0];

    // Assign referral code — always, non-optional
    let referralCode = null;
    try {
      referralCode = await assignReferralCode(user.id);
    } catch(e) {
      console.warn('[signup] assignReferralCode failed:', e.message);
    }

    if (ref) {
      try {
        const refUser = await pool.query('SELECT id FROM users WHERE referral_code=UPPER($1)', [ref]);
        if (refUser.rows.length && refUser.rows[0].id !== user.id) {
          await client.query(
            `INSERT INTO referrals (referrer_id,referred_id,code,status,credited)
             VALUES ($1,$2,UPPER($3),'pending',FALSE) ON CONFLICT(referred_id) DO NOTHING`,
            [refUser.rows[0].id, user.id, ref]
          );
        }
      } catch(e) {}
    }

    // Credit pending payments
    try {
      const pending = await client.query(
        'SELECT * FROM pending_payments WHERE LOWER(email)=$1 AND credited_at IS NULL', [trimEmail]
      );
      for (const p of pending.rows) {
        const pack = CREDIT_PACKS[p.pack_id];
        if (pack) {
          await client.query(
            `INSERT INTO purchases (user_id,stripe_session_id,pack_id,credits,amount_cents,currency,status,completed_at)
             VALUES ($1,$2,$3,$4,$5,'eur','completed',NOW()) ON CONFLICT(stripe_session_id) DO NOTHING`,
            [user.id, p.transaction_id, pack.id, pack.credits, pack.amountCents]
          );
          await client.query('UPDATE users SET credits=credits+$1 WHERE id=$2', [pack.credits, user.id]);
          await client.query('UPDATE pending_payments SET credited_at=NOW() WHERE id=$1', [p.id]);
        }
      }
    } catch(e) {}

    await client.query('COMMIT');

    const final = await pool.query(
      'SELECT id,username,email,credits,is_unlimited,is_admin,referral_code FROM users WHERE id=$1', [user.id]
    );
    const u = final.rows[0];
    const token = jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '30d' });

    setImmediate(() => sendWelcomeEmail(u.username, u.email));

    res.status(201).json({ token, user: u });
  } catch(err) {
    await client.query('ROLLBACK');
    if (err.code==='23505') return res.status(409).json({ error: 'Cet email est déjà utilisé' });
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });
    const r = await pool.query(
      `SELECT id,username,email,password_hash,credits,is_unlimited,is_admin,
              daily_credit_used_at,dice_roll_used_at,dice_roll_result,dice_draws_remaining,referral_code
       FROM users WHERE LOWER(email)=LOWER($1)`, [email.trim()]
    );
    if (!r.rows.length || !await bcrypt.compare(password, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const u = r.rows[0];
    const token = jwt.sign({ userId: u.id }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id:u.id,username:u.username,email:u.email,credits:u.credits,
      is_unlimited:u.is_unlimited,is_admin:u.is_admin,daily_credit_used_at:u.daily_credit_used_at,
      dice_roll_used_at:u.dice_roll_used_at,dice_roll_result:u.dice_roll_result,
      dice_draws_remaining:u.dice_draws_remaining,referral_code:u.referral_code } });
  } catch(err) { console.error('Login error:', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id,username,email,credits,is_unlimited,is_admin,daily_credit_used_at,
              dice_roll_used_at,dice_roll_result,dice_draws_remaining,referral_code
       FROM users WHERE id=$1`, [req.userId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    res.json({ user: r.rows[0] });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════════════
// READINGS ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/readings', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const mode = req.body?.mode || 'oracle';
    if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });

    await client.query('BEGIN');
    const ur = await client.query(
      'SELECT credits,is_unlimited,daily_credit_used_at FROM users WHERE id=$1 FOR UPDATE', [req.userId]
    );
    if (!ur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Utilisateur non trouvé' }); }

    const { credits, is_unlimited, daily_credit_used_at } = ur.rows[0];
    const dailyOk   = isDailyCreditAvailable({ daily_credit_used_at });
    const modeDaily = DAILY_CREDIT_MODES.includes(mode);
    const effective = credits + (modeDaily && dailyOk ? 1 : 0);

    if (!is_unlimited && effective < 1) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Crédits insuffisants', credits:0, daily_credit_available: dailyOk });
    }

    let cards;
    if (mode==='horoscope') {
      const sign = req.body?.zodiacSign;
      if (!sign||!ZODIAC_SIGNS[sign]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Signe invalide' }); }
      cards = [ZODIAC_SIGNS[sign]];
    } else {
      cards = drawCards(mode, 3);
    }

    let fortune;
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1',
        apiKey:  process.env.OPENAI_API_KEY,
      });
      const mp = MODE_PROMPTS[mode];
      let userContent;
      if (mode==='horoscope') userContent = mp.user(`${cards[0].name} ${cards[0].emoji} — traits : ${cards[0].traits}`);
      else if (mode==='question') userContent = mp.user(req.body?.question||'', cards.map(c=>`${c.emoji} ${c.name}`).join(', '));
      else userContent = mp.user(cards.map(c=>`${c.emoji} ${c.name} (${c.meaning})`).join(', '));

      const completion = await openai.chat.completions.create({
        model:'gpt-4o-mini', max_tokens:300, temperature:0.9,
        messages:[{ role:'system', content:mp.system },{ role:'user', content:userContent }],
      });
      fortune = completion.choices[0].message.content;
    } catch(aiErr) {
      console.error('[AI] Error:', aiErr.message);
      fortune = MODE_PROMPTS[mode].fallback(cards.map?.(c=>c.name).join(', ') || '');
    }

    // Deduct credit
    if (!is_unlimited) {
      if (modeDaily && dailyOk) {
        await client.query('UPDATE users SET daily_credit_used_at=NOW() WHERE id=$1', [req.userId]);
      } else {
        await client.query('UPDATE users SET credits=credits-1 WHERE id=$1', [req.userId]);
      }
    }

    // Check if first-ever draw for referral credit
    const prevDraws = await client.query('SELECT COUNT(*) AS n FROM readings WHERE user_id=$1', [req.userId]);
    const isFirstDraw = parseInt(prevDraws.rows[0].n)===0;

    const inserted = await client.query(
      `INSERT INTO readings (user_id,mode,cards,fortune,question,created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id,created_at`,
      [req.userId, mode, JSON.stringify(cards), fortune, req.body?.question||null]
    );

    // Update dice draws if applicable
    if (is_unlimited || true) {
      const diceCheck = await client.query(
        'SELECT dice_draws_remaining FROM users WHERE id=$1', [req.userId]
      );
      if (diceCheck.rows[0].dice_draws_remaining > 0 && !is_unlimited) {
        await client.query(
          'UPDATE users SET dice_draws_remaining=dice_draws_remaining-1 WHERE id=$1 AND dice_draws_remaining>0',
          [req.userId]
        );
      }
    }

    const updUser = await client.query(
      'SELECT credits,daily_credit_used_at,dice_draws_remaining FROM users WHERE id=$1', [req.userId]
    );
    await client.query('COMMIT');

    if (isFirstDraw) setImmediate(()=>creditReferrerForFirstDraw(req.userId));

    res.json({ reading: { ...inserted.rows[0], mode, cards, fortune }, user: updUser.rows[0] });
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('Reading error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════
// SHOP / STRIPE ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/shop/create-checkout', authMiddleware, async (req, res) => {
  const { packId } = req.body;
  const pack = CREDIT_PACKS[packId];
  if (!pack) return res.status(400).json({ error: 'Pack invalide' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Configuration paiement manquante' });

  const appUrl    = process.env.APP_URL || 'https://madame-fafi-6w0y.onrender.com';
  const successUrl = `${appUrl}/app?payment_success=1&session_id={CHECKOUT_SESSION_ID}&pack=${packId}`;
  const cancelUrl  = `${appUrl}/app?canceled=1`;
  const auth       = 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY+':').toString('base64');

  try {
    const resp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:'POST',
      headers:{ Authorization:auth, 'Content-Type':'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        mode:'payment',
        'payment_method_types[]':'card',
        'line_items[0][price_data][currency]':'eur',
        'line_items[0][price_data][unit_amount]': String(pack.amountCents),
        'line_items[0][price_data][product_data][name]': pack.name,
        'line_items[0][price_data][product_data][description]': `${pack.credits} consultations Madame Fafi`,
        'line_items[0][quantity]':'1',
        success_url: successUrl,
        cancel_url:  cancelUrl,
        'metadata[pack_id]':   packId,
        'metadata[credits]':   String(pack.credits),
        'customer_email':      req.userEmail||'',
      }).toString(),
    });
    const session = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: session.error?.message||'Erreur Stripe' });
    res.json({ url: session.url });
  } catch(err) { res.status(500).json({ error: 'Erreur connexion paiement' }); }
});

app.post('/api/shop/complete-purchase', authMiddleware, async (req, res) => {
  const { sessionId, packId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Session ID requis' });
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe non configuré' });

  try {
    const auth = 'Basic ' + Buffer.from(process.env.STRIPE_SECRET_KEY+':').toString('base64');
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, { headers:{ Authorization:auth } });
    const session = await resp.json();
    if (!resp.ok||session.payment_status!=='paid') return res.status(400).json({ error: 'Paiement non confirmé' });

    const pid   = session.metadata?.pack_id || packId;
    const pack  = CREDIT_PACKS[pid];
    if (!pack) return res.status(400).json({ error: 'Pack invalide' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO purchases (user_id,stripe_session_id,stripe_payment_intent_id,pack_id,credits,amount_cents,currency,status,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'eur','completed',NOW()) ON CONFLICT(stripe_session_id) DO NOTHING`,
        [req.userId, sessionId, session.payment_intent, pack.id, pack.credits, pack.amountCents]
      );
      if (ins.rowCount>0) await client.query('UPDATE users SET credits=credits+$1 WHERE id=$2', [pack.credits, req.userId]);
      await client.query('COMMIT');
      const u = await pool.query('SELECT credits FROM users WHERE id=$1', [req.userId]);
      res.json({ success:true, credits_added:pack.credits, new_balance:u.rows[0].credits });
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } catch(err) { console.error('[PURCHASE]', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// Stripe Webhook
app.post('/api/stripe/webhook', async (req, res) => {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  if (secret) {
    try {
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch(e) { return res.status(400).send('Webhook Error: '+e.message); }
  } else {
    try { event = JSON.parse(req.body); } catch { return res.status(400).send('Bad payload'); }
  }

  if (event.type==='checkout.session.completed') {
    const s     = event.data.object;
    const email = (s.customer_details?.email||s.customer_email||'').toLowerCase();
    const pid   = s.metadata?.pack_id;
    const pack  = CREDIT_PACKS[pid];
    if (!email||!pack) return res.json({ received:true });

    const client = await pool.connect();
    try {
      const ur = await client.query('SELECT id FROM users WHERE LOWER(email)=LOWER($1)', [email]);
      if (!ur.rows.length) {
        await pool.query(
          `INSERT INTO pending_payments (email,pack_id,credits,amount,description,transaction_id,created_at)
           VALUES (LOWER($1),$2,$3,$4,$5,$6,NOW()) ON CONFLICT(transaction_id) DO NOTHING`,
          [email, pack.id, pack.credits, pack.amountCents/100, pack.name, s.id]
        );
      } else {
        await client.query('BEGIN');
        const ins = await client.query(
          `INSERT INTO purchases (user_id,stripe_session_id,stripe_payment_intent_id,pack_id,credits,amount_cents,currency,status,completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,'eur','completed',NOW()) ON CONFLICT(stripe_session_id) DO NOTHING`,
          [ur.rows[0].id, s.id, s.payment_intent, pack.id, pack.credits, pack.amountCents]
        );
        if (ins.rowCount>0) {
          await client.query('UPDATE users SET credits=credits+$1 WHERE id=$2', [pack.credits, ur.rows[0].id]);
          console.log(`[WEBHOOK] ✅ ${pack.credits} crédits → ${email}`);
        }
        await client.query('COMMIT');
      }
    } catch(e) { await client.query('ROLLBACK'); console.error('[WEBHOOK]', e.message); }
    finally { client.release(); }
  }
  res.json({ received: true });
});

// GET /api/cards — deck pour le mode courant (prefetch avant flip)
app.get('/api/cards', authMiddleware, async (req, res) => {
  try {
    const mode = req.query.mode || 'oracle';
    const deckMap = {
      oracle:   ORACLE_CARDS,
      tarot:    TAROT_CARDS,
      amour:    AMOUR_CARDS,
      travail:  TRAVAIL_CARDS,
      question: QUESTION_CARDS,
      horoscope: Object.values(ZODIAC_SIGNS),
    };
    const cards = (deckMap[mode] || ORACLE_CARDS);
    const shuffled = [...cards].sort(() => Math.random() - 0.5);
    res.json({ cards: shuffled, mode });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════════════
// READINGS/FLIP — tirage carte par carte
// ═══════════════════════════════════════════════════════════════
app.post('/api/readings/flip', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const mode     = req.body?.mode || 'oracle';
    const question = req.body?.question || null;
    if (!VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Mode invalide' });

    await client.query('BEGIN');
    const ur = await client.query(
      'SELECT credits,is_unlimited,daily_credit_used_at,dice_draws_remaining FROM users WHERE id=$1 FOR UPDATE',
      [req.userId]
    );
    if (!ur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Utilisateur non trouvé' }); }

    const { credits, is_unlimited, daily_credit_used_at, dice_draws_remaining } = ur.rows[0];
    const dailyOk     = isDailyCreditAvailable({ daily_credit_used_at });
    const modeDaily   = DAILY_CREDIT_MODES.includes(mode);
    const useDice     = req.body?.dice_draw && dice_draws_remaining > 0;
    const effectiveCr = credits + (modeDaily && dailyOk ? 1 : 0);

    if (!is_unlimited && effectiveCr < 1 && !useDice) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Crédits insuffisants', credits: 0 });
    }

    // Draw one card
    let card;
    if (mode === 'horoscope') {
      const sign = req.body?.zodiacSign;
      if (!sign || !ZODIAC_SIGNS[sign]) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Signe invalide' }); }
      card = ZODIAC_SIGNS[sign];
    } else {
      card = drawCards(mode, 1)[0];
    }

    // Generate fortune via AI
    let fortune;
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1',
        apiKey:  process.env.OPENAI_API_KEY,
      });
      const mp = MODE_PROMPTS[mode];
      let userContent;
      if (mode === 'horoscope') userContent = mp.user(`${card.name} ${card.emoji} — traits : ${card.traits}`);
      else if (mode === 'question') userContent = mp.user(question||'', `${card.emoji} ${card.name}`);
      else userContent = mp.user(`${card.emoji} ${card.name} (${card.meaning})`);

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 300, temperature: 0.9,
        messages: [{ role:'system', content:mp.system },{ role:'user', content:userContent }],
      });
      fortune = completion.choices[0].message.content;
    } catch(aiErr) {
      console.error('[AI] flip error:', aiErr.message);
      fortune = MODE_PROMPTS[mode].fallback(card.name || '');
    }

    // Deduct credit
    if (!is_unlimited) {
      if (useDice) {
        await client.query('UPDATE users SET dice_draws_remaining=dice_draws_remaining-1 WHERE id=$1 AND dice_draws_remaining>0', [req.userId]);
      } else if (modeDaily && dailyOk) {
        await client.query('UPDATE users SET daily_credit_used_at=NOW() WHERE id=$1', [req.userId]);
      } else {
        await client.query('UPDATE users SET credits=credits-1 WHERE id=$1', [req.userId]);
      }
    }

    // Check first draw for referral
    const prevDraws = await client.query('SELECT COUNT(*) AS n FROM readings WHERE user_id=$1', [req.userId]);
    const isFirst   = parseInt(prevDraws.rows[0].n) === 0;

    // Save reading
    const ins = await client.query(
      `INSERT INTO readings (user_id,mode,cards,fortune,question,created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING id,created_at`,
      [req.userId, mode, JSON.stringify([card]), fortune, question]
    );

    await client.query('COMMIT');
    if (isFirst) setImmediate(() => creditReferrerForFirstDraw(req.userId));

    const updUser = await pool.query(
      'SELECT credits,daily_credit_used_at,dice_draws_remaining FROM users WHERE id=$1', [req.userId]
    );
    const u = updUser.rows[0];
    const newDailyOk = isDailyCreditAvailable(u);

    res.json({
      readingId: ins.rows[0].id,
      card, fortune,
      credits: u.credits,
      daily_credit_available: newDailyOk,
      dice_state: { dice_draws_remaining: u.dice_draws_remaining },
      readings_count: parseInt(prevDraws.rows[0].n) + 1,
    });
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('Flip error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// POST /api/readings/second-message
app.post('/api/readings/second-message', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { readingId } = req.body;
    if (!readingId) return res.status(400).json({ error: 'readingId requis' });

    // Verify reading belongs to user
    const rr = await pool.query('SELECT mode,cards,fortune,question FROM readings WHERE id=$1 AND user_id=$2', [readingId, req.userId]);
    if (!rr.rows.length) return res.status(404).json({ error: 'Lecture introuvable' });
    const reading = rr.rows[0];

    await client.query('BEGIN');
    const ur = await client.query('SELECT credits,is_unlimited,daily_credit_used_at FROM users WHERE id=$1 FOR UPDATE', [req.userId]);
    const { credits, is_unlimited, daily_credit_used_at } = ur.rows[0];
    const dailyOk   = isDailyCreditAvailable({ daily_credit_used_at });
    const modeDaily = DAILY_CREDIT_MODES.includes(reading.mode);
    const effective = credits + (modeDaily && dailyOk ? 1 : 0);

    if (!is_unlimited && effective < 1) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Crédits insuffisants', credits: 0 });
    }

    let second_fortune;
    try {
      const { OpenAI } = require('openai');
      const openai = new OpenAI({
        baseURL: process.env.OPENAI_BASE_URL || 'https://polsia.com/ai/openai/v1',
        apiKey:  process.env.OPENAI_API_KEY,
      });
      const mp = MODE_PROMPTS[reading.mode] || MODE_PROMPTS.oracle;
      const secondPrompt = reading.question
        ? `La personne a posé la question : "${reading.question}". Tu as déjà répondu une première fois. Maintenant, va plus loin — révèle quelque chose de plus profond et personnel. UNE SEULE PHRASE, encore plus révélatrice, en tutoyant.`
        : `Tu as déjà donné une première réponse. Maintenant révèle quelque chose de plus profond sur la situation. UNE SEULE PHRASE mystique et percutante, en tutoyant.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini', max_tokens: 200, temperature: 0.9,
        messages: [{ role:'system', content:mp.system },{ role:'user', content:secondPrompt }],
      });
      second_fortune = completion.choices[0].message.content;
    } catch(aiErr) {
      second_fortune = "Mon cœur, les forces de l'au-delà te soufflent que tu connais déjà la réponse — fais confiance à ton intuition.";
    }

    // Deduct credit
    if (!is_unlimited) {
      if (modeDaily && dailyOk) {
        await client.query('UPDATE users SET daily_credit_used_at=NOW() WHERE id=$1', [req.userId]);
      } else {
        await client.query('UPDATE users SET credits=credits-1 WHERE id=$1', [req.userId]);
      }
    }
    await client.query('COMMIT');

    const updUser = await pool.query('SELECT credits,daily_credit_used_at FROM users WHERE id=$1', [req.userId]);
    const u = updUser.rows[0];

    res.json({
      second_fortune,
      credits: u.credits,
      daily_credit_available: isDailyCreditAvailable(u),
    });
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('Second message error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════
// REVIEWS ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const { comment, rating } = req.body;
    if (!comment?.trim()||comment.trim().length<5||comment.trim().length>500)
      return res.status(400).json({ error: 'Commentaire : entre 5 et 500 caractères' });
    const r = parseInt(rating);
    if (!r||r<1||r>5) return res.status(400).json({ error: 'Note invalide (1 à 5 étoiles)' });
    const exists = await pool.query('SELECT id FROM reviews WHERE user_id=$1 AND is_deleted=false', [req.userId]);
    if (exists.rows.length) return res.status(409).json({ error: 'Tu as déjà laissé un avis' });
    const u = await pool.query('SELECT username FROM users WHERE id=$1', [req.userId]);
    const ins = await pool.query(
      'INSERT INTO reviews (user_id,username,comment,rating) VALUES ($1,$2,$3,$4) RETURNING id,username,comment,rating,created_at',
      [req.userId, u.rows[0].username, comment.trim(), r]
    );
    res.status(201).json({ review: ins.rows[0] });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/reviews/me', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id FROM reviews WHERE user_id=$1 AND is_deleted=false', [req.userId]);
    res.json({ hasReview: r.rows.length>0 });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/reviews', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id,username,comment,rating,created_at FROM reviews WHERE is_deleted=false ORDER BY created_at DESC LIMIT 50'
    );
    res.json({ reviews: r.rows });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/reviews/:id', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('UPDATE reviews SET is_deleted=true WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Avis introuvable' });
    res.json({ deleted:true, id:r.rows[0].id });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════════════
// PROMO ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/promo/redeem', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    const { code } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'Code promo requis' });
    await client.query('BEGIN');
    const cr = await client.query('SELECT id,credits,max_uses,is_active FROM promo_codes WHERE UPPER(code)=UPPER($1)', [code.trim()]);
    if (!cr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Code promo invalide' }); }
    const promo = cr.rows[0];
    if (!promo.is_active) { await client.query('ROLLBACK'); return res.status(400).json({ error: "Code promo inactif" }); }
    const used = await client.query('SELECT id FROM promo_code_uses WHERE promo_code_id=$1 AND user_id=$2', [promo.id,req.userId]);
    if (used.rows.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Code déjà utilisé' }); }
    if (promo.max_uses!=null) {
      const cnt = await client.query('SELECT COUNT(*) AS n FROM promo_code_uses WHERE promo_code_id=$1', [promo.id]);
      if (parseInt(cnt.rows[0].n)>=promo.max_uses) { await client.query('ROLLBACK'); return res.status(400).json({ error: "Limite d'utilisation atteinte" }); }
    }
    await client.query('INSERT INTO promo_code_uses (promo_code_id,user_id,credits) VALUES ($1,$2,$3)', [promo.id,req.userId,promo.credits]);
    const ur = await client.query('UPDATE users SET credits=credits+$1 WHERE id=$2 RETURNING credits', [promo.credits,req.userId]);
    await client.query('COMMIT');
    res.json({ success:true, credits_added:promo.credits, new_balance:ur.rows[0].credits });
  } catch(err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Erreur serveur' });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════
// DICE ROUTE
// ═══════════════════════════════════════════════════════════════
app.post('/api/dice/roll', authMiddleware, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!isSundayParis()) return res.status(403).json({ error: "Le dé n'est disponible que le dimanche 🎲", is_sunday:false });
    await client.query('BEGIN');
    const ur = await client.query(
      'SELECT id,dice_roll_used_at,dice_roll_result,dice_draws_remaining FROM users WHERE id=$1 FOR UPDATE', [req.userId]
    );
    if (!ur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Utilisateur non trouvé' }); }
    const ds = getDiceState(ur.rows[0]);
    if (ds.has_rolled_this_week) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Dé déjà lancé cette semaine', dice_state:ds }); }
    const result = Math.floor(Math.random()*6)+1;
    await client.query('UPDATE users SET dice_roll_used_at=NOW(),dice_roll_result=$1,dice_draws_remaining=$1 WHERE id=$2', [result,req.userId]);
    await client.query('COMMIT');
    res.json({ result, dice_state:{ is_sunday:true,has_rolled_this_week:true,dice_roll_result:result,dice_draws_remaining:result,can_roll:false } });
  } catch(err) { await client.query('ROLLBACK'); res.status(500).json({ error: 'Erreur serveur' }); }
  finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════
// REFERRAL ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/referral-code', authMiddleware, async (req, res) => {
  try {
    let r = await pool.query('SELECT referral_code FROM users WHERE id=$1', [req.userId]);
    let code = r.rows[0]?.referral_code;
    // Auto-assign code if user doesn't have one yet
    if (!code) {
      code = await assignReferralCode(req.userId);
    }
    if (!code) return res.status(500).json({ error: 'Impossible de générer le code' });
    const appUrl = process.env.APP_URL || 'https://madame-fafi-6w0y.onrender.com';
    res.json({ code, link: `${appUrl}?ref=${code}` });
  } catch(err) { console.error('[referral-code]', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/referral-stats', authMiddleware, async (req, res) => {
  try {
    // Auto-assign referral code if user doesn't have one
    const codeCheck = await pool.query('SELECT referral_code FROM users WHERE id=$1', [req.userId]);
    let code = codeCheck.rows[0]?.referral_code;
    if (!code) {
      code = await assignReferralCode(req.userId);
    }
    if (!code) return res.status(500).json({ error: 'Impossible de générer le code' });

    const r = await pool.query(
      `SELECT COUNT(ref.id)::int AS total,
              COUNT(ref.id) FILTER(WHERE ref.credited=TRUE)::int AS credited
       FROM referrals ref WHERE ref.referrer_id=$1`, [req.userId]
    );
    const appUrl = process.env.APP_URL || 'https://madame-fafi-6w0y.onrender.com';
    res.json({
      code,
      link:              `${appUrl}?ref=${code}`,
      total_referrals:   r.rows[0]?.total   || 0,
      credited_referrals: r.rows[0]?.credited || 0,
    });
  } catch(err) { console.error('[referral-stats]', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════════════
// USER ROUTE
// ═══════════════════════════════════════════════════════════════
app.get('/api/user/review-prompt-eligible', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT credits FROM users WHERE id=$1', [req.userId]);
    res.json({ eligible:true, review_link:REVIEW_LINK });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ═══════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!password||password!==ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const token = jwt.sign({ admin:true }, ADMIN_JWT_SECRET, { expiresIn:'8h' });
  res.json({ token });
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const search = req.query.search||'';
    let q, p;
    const sub = `(SELECT r.mode FROM readings r WHERE r.user_id=users.id AND r.mode=ANY(ARRAY['oracle','tarot']) AND (r.created_at AT TIME ZONE 'Europe/Paris')::date=(NOW() AT TIME ZONE 'Europe/Paris')::date ORDER BY r.created_at DESC LIMIT 1) AS daily_credit_mode`;
    if (search) {
      q=`SELECT id,username,email,credits,is_unlimited,is_admin,created_at,daily_credit_used_at,dice_roll_used_at,dice_roll_result,dice_draws_remaining,${sub} FROM users WHERE LOWER(username) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1) ORDER BY created_at DESC`;
      p=[`%${search}%`];
    } else {
      q=`SELECT id,username,email,credits,is_unlimited,is_admin,created_at,daily_credit_used_at,dice_roll_used_at,dice_roll_result,dice_draws_remaining,${sub} FROM users ORDER BY created_at DESC`;
      p=[];
    }
    const r = await pool.query(q, p);
    const cnt = await pool.query('SELECT COUNT(*) FROM users');
    res.json({ users: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,username,email,credits,is_unlimited,is_admin,created_at FROM users WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user: r.rows[0] });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/users/:id/credits', adminMiddleware, async (req, res) => {
  try {
    const n = parseInt(req.body.amount);
    if (!n||n<1||n>10000) return res.status(400).json({ error: 'Montant invalide' });
    const r = await pool.query('UPDATE users SET credits=credits+$1 WHERE id=$2 RETURNING id,username,email,credits', [n, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user: r.rows[0] });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/users/:id/unlimited', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('UPDATE users SET is_unlimited=$1 WHERE id=$2 RETURNING id,username,email,credits,is_unlimited', [!!req.body.unlimited, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user: r.rows[0] });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/users/:id/readings', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,mode,cards,fortune,created_at FROM readings WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ readings: r.rows });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/users/:id/purchases', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,pack_id,credits,amount_cents,currency,status,created_at,completed_at FROM purchases WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
    res.json({ purchases: r.rows });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const [users, purchases, readings, credits] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER(WHERE created_at > NOW()-INTERVAL '7 days')::int AS new_7d FROM users"),
      pool.query("SELECT COUNT(*)::int AS total, COALESCE(SUM(amount_cents),0)::int AS revenue FROM purchases WHERE status='completed'"),
      pool.query('SELECT COUNT(*)::int AS total FROM readings'),
      pool.query('SELECT COALESCE(SUM(credits),0)::int AS total FROM users'),
    ]);
    res.json({
      total_users:               users.rows[0].total,
      new_users_7d:              users.rows[0].new_7d,
      total_readings:            readings.rows[0].total,
      total_purchases:           purchases.rows[0].total,
      total_revenue_cents:       purchases.rows[0].revenue,
      total_credits_outstanding: credits.rows[0].total,
    });
  } catch(err) { console.error('[STATS]', err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/emails', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,recipient_email,recipient_username,subject,status,sent_at FROM sent_emails ORDER BY sent_at DESC LIMIT 100');
    res.json({ emails: r.rows });
  } catch { res.json({ emails: [] }); }
});

app.get('/api/admin/payments', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT p.id, p.pack_id, p.credits, p.amount_cents, p.currency, p.status,
              p.created_at AS date, p.completed_at,
              u.username, u.email,
              ROUND(p.amount_cents::numeric/100,2) AS amount_eur,
              CASE p.pack_id
                WHEN '5'  THEN '5 Tirages'
                WHEN '15' THEN '15 Tirages'
                WHEN '30' THEN '30 Tirages'
                WHEN '60' THEN '60 Tirages'
                ELSE p.pack_id
              END AS pack_name
       FROM purchases p
       JOIN users u ON u.id=p.user_id
       WHERE p.status='completed'
       ORDER BY p.created_at DESC
       LIMIT 200`
    );
    const totalRevenue = r.rows.reduce((sum,p) => sum + (parseInt(p.amount_cents)||0), 0);
    res.json({
      payments:            r.rows,
      total_count:         r.rows.length,
      total_revenue_cents: totalRevenue,
    });
  } catch(err) { console.error(err); res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/promo-codes', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT pc.id,pc.code,pc.credits,pc.max_uses,pc.is_active,pc.created_at,COUNT(pcu.id)::int AS uses_count FROM promo_codes pc LEFT JOIN promo_code_uses pcu ON pcu.promo_code_id=pc.id GROUP BY pc.id ORDER BY pc.created_at DESC`);
    res.json({ promo_codes: r.rows });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/promo-codes', adminMiddleware, async (req, res) => {
  try {
    const { code, credits, max_uses, unlimited } = req.body;
    if (!code?.trim()) return res.status(400).json({ error: 'Nom du code requis' });
    const c = parseInt(credits);
    if (!c||c<1||c>10000) return res.status(400).json({ error: 'Crédits invalides' });
    const maxU = unlimited ? null : parseInt(max_uses);
    if (!unlimited&&(!maxU||maxU<1)) return res.status(400).json({ error: "Limite d'utilisations invalide" });
    const r = await pool.query(
      'INSERT INTO promo_codes (code,credits,max_uses) VALUES (UPPER($1),$2,$3) RETURNING id,code,credits,max_uses,is_active,created_at',
      [code.trim(), c, maxU]
    );
    res.json({ promo_code: r.rows[0] });
  } catch(err) {
    if (err.code==='23505') return res.status(400).json({ error: 'Ce code existe déjà' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/admin/promo-codes/:id', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('UPDATE promo_codes SET is_active=$1 WHERE id=$2 RETURNING id,code,credits,max_uses,is_active,created_at', [!!req.body.is_active, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Code introuvable' });
    res.json({ promo_code: r.rows[0] });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.delete('/api/admin/promo-codes/:id', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM promo_codes WHERE id=$1 RETURNING id,code', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Code introuvable' });
    res.json({ deleted:true, code:r.rows[0].code });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/traffic-sources', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(`SELECT COALESCE(signup_source,'direct') AS source, COUNT(*) AS signups FROM users GROUP BY source ORDER BY signups DESC`);
    res.json({ sources: r.rows });
  } catch { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/admin/mode-stats
app.get('/api/admin/mode-stats', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT mode, COUNT(*) AS count,
              COUNT(*) FILTER(WHERE created_at > NOW()-INTERVAL '7 days') AS count_7d
       FROM readings GROUP BY mode ORDER BY count DESC`
    );
    const today = await pool.query(
      `SELECT mode, COUNT(*) AS count FROM readings
       WHERE created_at > NOW()-INTERVAL '24 hours' GROUP BY mode`
    );
    res.json({ modes: r.rows, today: today.rows });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// POST /api/admin/send-email
app.post('/api/admin/send-email', adminMiddleware, async (req, res) => {
  try {
    const { userId, subject, message } = req.body;
    if (!userId || !subject || !message) return res.status(400).json({ error: 'Champs requis manquants' });
    const ur = await pool.query('SELECT username, email FROM users WHERE id=$1', [userId]);
    if (!ur.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const { username, email } = ur.rows[0];
    await sendWelcomeEmail(username, email); // reuse email helper for now
    // Log the email
    try {
      await pool.query(
        `INSERT INTO sent_emails (recipient_email,recipient_username,subject,message,status,sent_at)
         VALUES (LOWER($1),$2,$3,$4,'sent',NOW())`,
        [email, username, subject, message]
      );
    } catch(e) {}
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// DELETE /api/admin/users/:id
app.delete('/api/admin/users/:id', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM users WHERE id=$1 RETURNING id,username', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ deleted: true, id: r.rows[0].id, username: r.rows[0].username });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/admin/reviews
app.get('/api/admin/reviews', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.username, r.comment, r.rating, r.is_deleted, r.created_at,
              u.email FROM reviews r JOIN users u ON u.id=r.user_id
       ORDER BY r.created_at DESC LIMIT 100`
    );
    res.json({ reviews: r.rows });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// GET /api/admin/promo-codes/:id/uses
app.get('/api/admin/promo-codes/:id/uses', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT pcu.id, pcu.credits, pcu.used_at, u.id AS user_id, u.username, u.email
       FROM promo_code_uses pcu JOIN users u ON u.id=pcu.user_id
       WHERE pcu.promo_code_id=$1 ORDER BY pcu.used_at DESC`,
      [req.params.id]
    );
    res.json({ uses: r.rows });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Catch-all admin API
app.use('/api/admin', adminMiddleware, (req, res) => {
  res.json({ success:true, data:[], emails:[], stats:{} });
});

// ─── STATIC PAGES ─────────────────────────────────────────────
// Fonctionne avec ou sans dossier public/ (compatible GitHub upload web)
const fs = require('fs');
function htmlFile(name) {
  const inPublic = path.join(__dirname, 'public', name);
  const atRoot   = path.join(__dirname, name);
  return fs.existsSync(inPublic) ? inPublic : atRoot;
}
const staticDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;

app.get('/admin', (req,res) => res.sendFile(htmlFile('admin.html')));
app.get('/app',   (req,res) => res.sendFile(htmlFile('app.html')));
app.get('/cgv',   (req,res) => res.sendFile(htmlFile('cgv.html')));
app.get('/politique-de-confidentialite', (req,res) => res.sendFile(htmlFile('politique.html')));
app.use(express.static(staticDir, { maxAge: '7d', etag: true }));
app.get('*', (req,res) => res.sendFile(htmlFile('index.html')));

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅ Madame Fafi running on port ${PORT}`));
