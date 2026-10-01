// WestJet Miles Shop (version indépendante, avec faux port pour Render)
const http = require("http");

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  })
  .listen(process.env.PORT || 3000);


const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SHOP_TOKEN;
const CLIENT_ID = process.env.SHOP_CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const STAFF_ROLE_ID = process.env.STAFF_ROLE_ID;
const LOG_CHANNEL_ID = process.env.SHOP_LOG_CHANNEL_ID;

// si les variables du shop ne sont pas là, on ne fait rien
if (!TOKEN || !CLIENT_ID || !GUILD_ID) return;

// ---------- ce qu'on vend (change les prix ici) ----------
const ITEMS = {
  premium: { name: "Premium Economy", price: 6000 },
  business: { name: "Business Class", price: 12500 },
  first: { name: "First Class", price: 25000 },
};

// statut selon le total de miles gagnés, avec un rabais sur les prix
const TIERS = [
  { name: "Platinum", min: 30000, off: 0.15 },
  { name: "Gold", min: 15000, off: 0.1 },
  { name: "Silver", min: 5000, off: 0.05 },
  { name: "Member", min: 0, off: 0 },
];

// ---------- fichiers ----------
const DATA_DIR = path.join(__dirname, "data");
const MILES_FILE = path.join(DATA_DIR, "miles.json");
const FLIGHTS_FILE = path.join(DATA_DIR, "flights.json");
const SHOP_FILE = path.join(DATA_DIR, "shop.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function read(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

const getMiles = (id) => read(MILES_FILE, {})[id] || 0;
const getFlights = () => read(FLIGHTS_FILE, []);
const getShop = () => {
  const s = read(SHOP_FILE, {});
  return { spent: s.spent || {}, orders: s.orders || [] };
};

// miles gagnés au total = solde actuel + ce qui a été dépensé dans le shop
function getEarned(id) {
  return getMiles(id) + (getShop().spent[id] || 0);
}

const getTier = (earned) => TIERS.find((t) => earned >= t.min);
const priceFor = (item, earned) => Math.round(item.price * (1 - getTier(earned).off));
const fmt = (n) => n.toLocaleString("en-US");

function isStaff(i) {
  if (i.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return STAFF_ROLE_ID ? i.member.roles.cache.has(STAFF_ROLE_ID) : false;
}

// ---------- affichage ----------
function shopView(userId) {
  const balance = getMiles(userId);
  const earned = getEarned(userId);
  const tier = getTier(earned);

  const embed = new EmbedBuilder()
    .setTitle("WestJet Miles Shop")
    .setColor(0x1abc9c)
    .setDescription(
      `Balance: **${fmt(balance)} miles**\nStatus: **${tier.name}**` +
        (tier.off ? ` (${Math.round(tier.off * 100)}% off)` : "")
    )
    .addFields(
      Object.values(ITEMS).map((it) => ({
        name: it.name,
        value: `${fmt(priceFor(it, earned))} miles`,
        inline: true,
      }))
    )
    .setFooter({ text: "WestJet | Miles Shop" });

  const menu = new StringSelectMenuBuilder()
    .setCustomId("ms_pick")
    .setPlaceholder("Pick a class")
    .addOptions(
      Object.entries(ITEMS).map(([key, it]) => ({
        label: it.name,
        description: `${fmt(priceFor(it, earned))} miles`,
        value: key,
      }))
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
}

function statusText(userId) {
  const balance = getMiles(userId);
  const earned = getEarned(userId);
  const tier = getTier(earned);
  const next = [...TIERS].reverse().find((t) => t.min > earned);
  let txt = `You have **${fmt(balance)} miles**.\nStatus: **${tier.name}**`;
  if (tier.off) txt += ` (${Math.round(tier.off * 100)}% off the shop)`;
  if (next) txt += `\n${fmt(next.min - earned)} more miles to reach **${next.name}**.`;
  return txt;
}

// choix en cours pour chaque membre
const pending = new Map();
const TEN_MIN = 10 * 60 * 1000;

function getPending(userId) {
  const p = pending.get(userId);
  if (!p || Date.now() - p.ts > TEN_MIN) {
    pending.delete(userId);
    return null;
  }
  return p;
}

const eph = MessageFlags.Ephemeral;

// ---------- commandes slash ----------
async function deploy() {
  const commands = [
    new SlashCommandBuilder().setName("shop").setDescription("Open the miles shop"),
    new SlashCommandBuilder().setName("status").setDescription("See your miles and your status"),
    new SlashCommandBuilder().setName("shoppanel").setDescription("Post the shop panel (staff only)"),
    new SlashCommandBuilder()
      .setName("addflight")
      .setDescription("Add an event flight to the list (staff only)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Example: QS 2210 YUL-CDG").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("delflight")
      .setDescription("Remove an event flight from the list (staff only)")
      .addStringOption((o) =>
        o.setName("name").setDescription("Exact name of the flight").setRequired(true)
      ),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ---------- bot ----------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  deploy().catch(() => {});
});

client.on(Events.InteractionCreate, async (i) => {
  try {
    // ----- slash -----
    if (i.isChatInputCommand()) {
      if (i.commandName === "shop") {
        return i.reply({ ...shopView(i.user.id), flags: eph });
      }

      if (i.commandName === "status") {
        return i.reply({ content: statusText(i.user.id), flags: eph });
      }

      if (i.commandName === "shoppanel") {
        if (!isStaff(i)) return i.reply({ content: "You can't use this.", flags: eph });

        const embed = new EmbedBuilder()
          .setTitle("WestJet Miles Shop")
          .setColor(0x1abc9c)
          .setDescription(
            "Spend your miles on an upgrade for one of our event flights.\n\n" +
              Object.values(ITEMS)
                .map((it) => `**${it.name}**: ${fmt(it.price)} miles`)
                .join("\n") +
              "\n\nHigher status means cheaper upgrades."
          )
          .setFooter({ text: "WestJet | Miles Shop" });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ms_open").setLabel("Open Shop").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("ms_status").setLabel("My Status").setStyle(ButtonStyle.Secondary)
        );

        await i.channel.send({ embeds: [embed], components: [row] });
        return i.reply({ content: "Panel posted.", flags: eph });
      }

      if (i.commandName === "addflight") {
        if (!isStaff(i)) return i.reply({ content: "You can't use this.", flags: eph });
        const name = i.options.getString("name").trim().slice(0, 90);
        const list = getFlights();
        if (list.length >= 25) {
          return i.reply({ content: "The list is full (25 flights max).", flags: eph });
        }
        if (list.includes(name)) {
          return i.reply({ content: "That flight is already in the list.", flags: eph });
        }
        list.push(name);
        write(FLIGHTS_FILE, list);
        return i.reply({ content: `Added **${name}**.`, flags: eph });
      }

      if (i.commandName === "delflight") {
        if (!isStaff(i)) return i.reply({ content: "You can't use this.", flags: eph });
        const name = i.options.getString("name").trim();
        const list = getFlights();
        if (!list.includes(name)) {
          return i.reply({ content: "Flight not found, check the exact name.", flags: eph });
        }
        write(FLIGHTS_FILE, list.filter((f) => f !== name));
        return i.reply({ content: `Removed **${name}**.`, flags: eph });
      }
    }

    // ----- boutons du panel -----
    if (i.isButton() && i.customId === "ms_open") {
      return i.reply({ ...shopView(i.user.id), flags: eph });
    }

    if (i.isButton() && i.customId === "ms_status") {
      return i.reply({ content: statusText(i.user.id), flags: eph });
    }

    // ----- 1. classe choisie, on demande le nom Roblox -----
    if (i.isStringSelectMenu() && i.customId === "ms_pick") {
      const key = i.values[0];
      const item = ITEMS[key];
      if (!item) return;

      const cost = priceFor(item, getEarned(i.user.id));
      const balance = getMiles(i.user.id);
      if (balance < cost) {
        return i.reply({
          content: `You need ${fmt(cost - balance)} more miles for ${item.name}.`,
          flags: eph,
        });
      }

      pending.set(i.user.id, { key, ts: Date.now() });

      const modal = new ModalBuilder().setCustomId("ms_roblox").setTitle("Your Roblox account");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId("roblox_name")
            .setLabel("What's your Roblox username?")
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(20)
            .setRequired(true)
        )
      );
      return i.showModal(modal);
    }

    // ----- 2. nom Roblox reçu, on choisit le vol event -----
    if (i.isModalSubmit() && i.customId === "ms_roblox") {
      const p = getPending(i.user.id);
      if (!p) return i.reply({ content: "That took too long, use /shop again.", flags: eph });

      const roblox = i.fields.getTextInputValue("roblox_name").trim();
      if (!/^[A-Za-z0-9_]{3,20}$/.test(roblox)) {
        return i.reply({
          content: "That doesn't look like a Roblox username. Try again from /shop.",
          flags: eph,
        });
      }
      p.roblox = roblox;

      const flights = getFlights();
      if (flights.length === 0) {
        return i.reply({ content: "There are no event flights open right now.", flags: eph });
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId("ms_flight")
        .setPlaceholder("Pick the event flight")
        .addOptions(flights.map((f) => ({ label: f, value: f })));

      return i.reply({
        content: "Which event flight is this upgrade for?",
        components: [new ActionRowBuilder().addComponents(menu)],
        flags: eph,
      });
    }

    // ----- 3. vol choisi, confirmation -----
    if (i.isStringSelectMenu() && i.customId === "ms_flight") {
      const p = getPending(i.user.id);
      if (!p) return i.update({ content: "That took too long, use /shop again.", components: [] });

      p.flight = i.values[0];
      const cost = priceFor(ITEMS[p.key], getEarned(i.user.id));

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ms_yes").setLabel("Confirm").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ms_no").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );

      return i.update({
        content:
          `**${ITEMS[p.key].name}** on **${p.flight}**\n` +
          `Roblox: **${p.roblox}**\n` +
          `Price: **${fmt(cost)} miles**`,
        components: [row],
      });
    }

    // ----- 4. confirmation finale -----
    if (i.isButton() && i.customId === "ms_no") {
      pending.delete(i.user.id);
      return i.update({ content: "Purchase cancelled.", components: [] });
    }

    if (i.isButton() && i.customId === "ms_yes") {
      const p = getPending(i.user.id);
      if (!p || !p.flight || !p.roblox) {
        return i.update({ content: "That took too long, use /shop again.", components: [] });
      }
      pending.delete(i.user.id);

      const item = ITEMS[p.key];
      const cost = priceFor(item, getEarned(i.user.id));

      const miles = read(MILES_FILE, {});
      if ((miles[i.user.id] || 0) < cost) {
        return i.update({ content: "You don't have enough miles anymore.", components: [] });
      }
      miles[i.user.id] -= cost;
      write(MILES_FILE, miles);

      const shop = getShop();
      shop.spent[i.user.id] = (shop.spent[i.user.id] || 0) + cost;
      const orderId = Date.now().toString(36).toUpperCase();
      shop.orders.push({
        id: orderId,
        user: i.user.id,
        roblox: p.roblox,
        item: item.name,
        flight: p.flight,
        cost,
        at: new Date().toISOString(),
      });
      write(SHOP_FILE, shop);

      if (LOG_CHANNEL_ID) {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle("New upgrade purchase")
            .setColor(0xf1c40f)
            .addFields(
              { name: "Member", value: `<@${i.user.id}>`, inline: true },
              { name: "Roblox", value: p.roblox, inline: true },
              { name: "Class", value: item.name, inline: true },
              { name: "Flight", value: p.flight, inline: true },
              { name: "Paid", value: `${fmt(cost)} miles`, inline: true },
              { name: "Order", value: orderId, inline: true }
            )
            .setTimestamp();
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`ms_done_${orderId}`)
              .setLabel("Mark as done")
              .setStyle(ButtonStyle.Success)
          );
          await channel.send({ embeds: [embed], components: [row] }).catch(() => {});
        }
      }

      return i.update({
        content:
          `Done! Your **${item.name}** on **${p.flight}** is booked for **${p.roblox}**.\n` +
          `Remaining balance: **${fmt(miles[i.user.id])} miles**. Staff will set it up for you.`,
        components: [],
      });
    }

    // ----- staff: commande traitée -----
    if (i.isButton() && i.customId.startsWith("ms_done_")) {
      if (!isStaff(i)) return i.reply({ content: "You can't use this.", flags: eph });
      const embed = EmbedBuilder.from(i.message.embeds[0])
        .setColor(0x2ecc71)
        .setFooter({ text: `Handled by ${i.user.username}` });
      return i.update({ embeds: [embed], components: [] });
    }
  } catch {
    if (i.isRepliable()) {
      const msg = { content: "Something went wrong, try again.", flags: eph };
      if (i.deferred || i.replied) i.followUp(msg).catch(() => {});
      else i.reply(msg).catch(() => {});
    }
  }
});

client.login(TOKEN).catch(() => {});
