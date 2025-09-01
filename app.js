/* =========================================================
   LoDeFROLL — Frontend (ethers v6, Viction)
   - Connect wallet, show VIC/FROLL + pool
   - Bet Lo (27 spins) / De (1 spin)
   - Read minBet & constants from contract; validate inputs
   - Preflight liquidity per on-chain formula to avoid reverts
   - Fast gas overrides (priority ↑, limit buffer)
   - Auto-approve allowance if needed
   - Parse events & show result
   - Decode Event Data (Tx hash / raw data) — Played & Settled
   - Lucky Picks: suggest-only, no auto-fill rows
   - Bet Status shows per-number stakes "NN: X FROLL"
========================================================= */

const CHAIN_ID_HEX = "0x58";                 // Viction chain id = 88
const RPC_URL      = "https://rpc.viction.xyz";
const EXPLORER     = "https://www.vicscan.xyz";

const FROLL_ADDR = "0xB4d562A8f811CE7F134a1982992Bd153902290BC";
const LOTO_ADDR  = "0xC05707443554fc1BAFD371085159aB0c381cCF01";

const FROLL_DECIMALS = 18;
const MAX_ROWS       = 100;

// ===== Minimal ABIs (khớp HĐ) =====
const FROLL_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const LOTO_ABI = [
  // views
  "function minBet() view returns (uint256)",
  "function contractBalance() view returns (uint256)",
  "function LO_DRAWS() view returns (uint256)",
  "function LO_PAYOUT_X() view returns (uint256)",
  "function DE_PAYOUT_X() view returns (uint256)",

  // core
  "function betLo(uint8[] numbers, uint256[] stakes) external",
  "function betDe(uint8[] numbers, uint256[] stakes) external",

  // events
  "event BetLoPlayed(address indexed player, uint8[] numbers, uint256[] stakes, uint256 totalStake)",
  "event BetLoSettled(address indexed player, uint8[] draws, uint256 grossPayout, uint256 netDiff)",
  "event BetDePlayed(address indexed player, uint8[] numbers, uint256[] stakes, uint256 totalStake)",
  "event BetDeSettled(address indexed player, uint8 draw, uint256 grossPayout, uint256 netDiff)",

  // custom errors
  "error PausedError()",
  "error InvalidInput()",
  "error DuplicateNumber()",
  "error BelowMinBet()",
  "error InsufficientAllowance()",
  "error InsufficientLiquidity()"
];

/* ===== State ===== */
let provider, signer, user, froll, lotto;
let minBetWei = 10n ** 15n; // fallback 0.001 FROLL
let CONST_LO_DRAWS = 27n, CONST_LO_X = 4n, CONST_DE_X = 70n; // fallback, sẽ đọc từ HĐ

/* ===== DOM helpers ===== */
const $  = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

function toast(msg){ const el=$("#status-msg"); if(el) el.textContent=msg; else console.log(msg); }

const fmt        = (x, d=6) => Number(x).toLocaleString(undefined,{maximumFractionDigits:d});
const fmtUnits   = (wei, dec=FROLL_DECIMALS) => ethers.formatUnits(wei, dec);
const parseUnits = (v, dec=FROLL_DECIMALS)  => ethers.parseUnits(String(v ?? "0"), dec);

/* ===== Fast gas overrides (speed up confirmation) ===== */
async function getFastOverrides() {
  const fee = await provider.getFeeData();
  const ov = {};
  if (fee.maxFeePerGas && fee.maxPriorityFeePerGas) {
    // EIP-1559 style
    let prio = fee.maxPriorityFeePerGas * 2n;                   // x2 priority
    if (prio < ethers.parseUnits("1", "gwei")) {
      prio = ethers.parseUnits("1", "gwei");                    // floor
    }
    let max = (fee.maxFeePerGas * 12n) / 10n;                   // x1.2 cap
    if (max <= prio) max = prio + ethers.parseUnits("1", "gwei");
    ov.maxPriorityFeePerGas = prio;
    ov.maxFeePerGas = max;
  } else if (fee.gasPrice) {
    // Legacy style
    ov.gasPrice = (fee.gasPrice * 125n) / 100n;                 // +25%
  } else {
    // Conservative fallback
    ov.gasPrice = ethers.parseUnits("1", "gwei");
  }
  return ov;
}

/* ===== Chain / Wallet ===== */
async function ensureChain(){
  const eth = window.ethereum;
  if(!eth) throw new Error("MetaMask not found.");
  const cid = await eth.request({method:"eth_chainId"});
  if (cid !== CHAIN_ID_HEX){
    try{
      await eth.request({method:"wallet_switchEthereumChain", params:[{chainId:CHAIN_ID_HEX}]});
    }catch(e){
      if(e.code === 4902){
        await eth.request({
          method:"wallet_addEthereumChain",
          params:[{
            chainId: CHAIN_ID_HEX,
            chainName: "Viction",
            nativeCurrency: {name:"VIC", symbol:"VIC", decimals:18},
            rpcUrls:[RPC_URL],
            blockExplorerUrls:[EXPLORER]
          }]
        });
      } else { throw e; }
    }
  }
}

async function connectWallet(){
  try{
    await ensureChain();
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    signer = await provider.getSigner();
    user   = await signer.getAddress();

    froll = new ethers.Contract(FROLL_ADDR, FROLL_ABI, signer);
    lotto = new ethers.Contract(LOTO_ADDR,  LOTO_ABI,  signer);

    $("#wallet-address")?.replaceChildren(document.createTextNode(user));
    toast("Wallet connected.");

    // Read runtime params from contract
    try {
      const [m, d, lx, dx] = await Promise.all([
        lotto.minBet(),
        lotto.LO_DRAWS?.().catch(()=>CONST_LO_DRAWS),
        lotto.LO_PAYOUT_X?.().catch(()=>CONST_LO_X),
        lotto.DE_PAYOUT_X?.().catch(()=>CONST_DE_X)
      ]);
      minBetWei       = m ?? minBetWei;
      CONST_LO_DRAWS  = d ?? CONST_LO_DRAWS;
      CONST_LO_X      = lx ?? CONST_LO_X;
      CONST_DE_X      = dx ?? CONST_DE_X;
    } catch {}

    // Sync placeholder min bet
    $$(".stakes").forEach(inp=>{
      inp.min = Number(fmtUnits(minBetWei));
      if(!inp.placeholder || /0\.001/i.test(inp.placeholder)){
        inp.placeholder = `≥ ${fmtUnits(minBetWei)} FROLL`;
      }
    });

    await refreshBalances();
  }catch(e){
    console.error(e);
    toast("Error connecting to wallet. Please ensure MetaMask is installed and on Viction.");
  }
}

async function refreshBalances(){
  try{
    if(!provider || !user) return;
    const vic = await provider.getBalance(user);
    $("#vic-balance").textContent   = `${fmt(ethers.formatEther(vic),4)} VIC`;
    const fUser = await froll.balanceOf(user);
    $("#froll-balance").textContent = `${fmt(fmtUnits(fUser),6)} FROLL`;
    const fPool = await froll.balanceOf(LOTO_ADDR);
    $("#froll-pool").textContent    = `${fmt(fmtUnits(fPool),2)} FROLL`;
  }catch(e){
    console.error(e);
    toast("Failed to refresh balances.");
  }
}

/* ===== Bet rows ===== */
function bindRowEvents(row){
  const num=row.querySelector(".numbers");
  const amt=row.querySelector(".stakes");
  const bAdd=row.querySelector(".add-row-btn");
  const bClr=row.querySelector(".clear-btn");
  const bRem=row.querySelector(".remove-row-btn");
  const recalc=()=>calcTotal();

  num?.addEventListener("input",recalc);
  amt?.addEventListener("input",recalc);

  bAdd?.addEventListener("click",()=>addRow());
  bClr?.addEventListener("click",()=>{ if(num) num.value=""; if(amt) amt.value=""; recalc(); });
  bRem?.addEventListener("click",()=>{
    const all=$$("#bet-numbers-container .bet-row");
    if(all.length<=1) return;
    row.remove();
    updateRemoveButtons();
    recalc();
  });
}

function updateRemoveButtons(){
  const rows=$$("#bet-numbers-container .bet-row");
  const dis = rows.length<=1;
  rows.forEach(r=>{ const b=r.querySelector(".remove-row-btn"); if(b) b.disabled=dis; });
}

function addRow(){
  const rows=$$("#bet-numbers-container .bet-row");
  if(rows.length>=MAX_ROWS){ toast(`Maximum ${MAX_ROWS} rows.`); return; }
  const tpl=$("#bet-row-template");
  const node=tpl.content.firstElementChild.cloneNode(true);
  $("#bet-numbers-container").appendChild(node);
  bindRowEvents(node);
  updateRemoveButtons();
}

function initRows(){
  const first=$("#bet-numbers-container .bet-row");
  if(first) bindRowEvents(first);
  updateRemoveButtons();
  calcTotal();
}

function collectBets(){
  const rows=$$("#bet-numbers-container .bet-row");
  const numbers=[], stakes=[];
  const seen=new Set();

  for(const r of rows){
    const nEl=r.querySelector(".numbers");
    const aEl=r.querySelector(".stakes");
    const nRaw=(nEl?.value||"").trim();
    const aRaw=(aEl?.value||"").trim();

    if(!nRaw && !aRaw) continue;

    const n=Number(nRaw);
    if(!Number.isInteger(n) || n<0 || n>99) throw new Error("Invalid number — please enter 00–99.");
    if(seen.has(n)) throw new Error("Duplicate number — each number must be unique.");
    seen.add(n);

    if(!aRaw || Number(aRaw)<=0) throw new Error("Invalid stake amount.");
    const stakeWei = parseUnits(aRaw);
    if(stakeWei < minBetWei) throw new Error(`Each stake must be ≥ ${fmtUnits(minBetWei)} FROLL.`);

    numbers.push(n);
    stakes.push(stakeWei);
  }

  if(numbers.length===0) throw new Error("Please enter at least one bet.");
  if(numbers.length>100) throw new Error("Maximum 100 numbers per bet.");

  return {numbers, stakes};
}

function calcTotal(){
  const rows=$$("#bet-numbers-container .bet-row");
  let total=0n;
  for(const r of rows){
    const aEl=r.querySelector(".stakes");
    const aRaw=(aEl?.value||"").trim();
    if(aRaw && Number(aRaw)>0) total += parseUnits(aRaw);
  }
  $("#total-stake").textContent = fmt(fmtUnits(total));
  return total;
}

/* ===== Repeat / Double / Half ===== */
let lastBets = null;

function applyRepeat(){
  if(!lastBets) return;
  $("#bet-numbers-container").innerHTML="";
  for(let i=0;i<lastBets.numbers.length;i++){
    const tpl=$("#bet-row-template");
    const node=tpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".numbers").value = String(lastBets.numbers[i]).padStart(2,"0");
    node.querySelector(".stakes").value  = lastBets.stakes[i];
    $("#bet-numbers-container").appendChild(node);
    bindRowEvents(node);
  }
  updateRemoveButtons();
  calcTotal();
}
function applyDouble(){ $$("#bet-numbers-container .stakes").forEach(inp=>{const v=Number(inp.value||"0"); if(v>0) inp.value=String(v*2);}); calcTotal(); }
function applyHalf(){   $$("#bet-numbers-container .stakes").forEach(inp=>{const v=Number(inp.value||"0"); if(v>0) inp.value=String(v/2);}); calcTotal(); }

/* ===== Allowance ===== */
async function ensureAllowance(neededWei){
  const cur = await froll.allowance(user, LOTO_ADDR);
  if (cur >= neededWei) return;
  toast("Approving FROLL...");

  const feeOv = await getFastOverrides();
  const tx = await froll.approve(LOTO_ADDR, neededWei, feeOv);
  toast(`Approve submitted: ${tx.hash}. Waiting...`);
  await tx.wait();
}

/* ===== Preflight liquidity (khớp công thức HĐ) =====
   - Lo  : worst = LO_DRAWS * LO_PAYOUT_X * maxStake
   - De  : worst = DE_PAYOUT_X * maxStake
   - HĐ kiểm tra: FROLL(balance) + totalStake >= worstCase  → nếu không: revert InsufficientLiquidity
*/
async function preflightLiquidity(stakes, betType){
  let total=0n, maxStake=0n;
  for(const s of stakes){ total+=s; if(s>maxStake) maxStake=s; }

  const pool = await froll.balanceOf(LOTO_ADDR);

  const LO_DRAWS  = CONST_LO_DRAWS;
  const LO_X      = CONST_LO_X;
  const DE_X      = CONST_DE_X;

  const worst = (betType === "matchup")
    ? (DE_X * maxStake)                                   // De
    : (LO_DRAWS * LO_X * maxStake);                       // Lo

  if (pool + total < worst) {
    throw new Error(
      `Pool insufficient for worst-case payout. Needs ≥ ${fmt(fmtUnits(worst))} FROLL (your total + pool is lower).`
    );
  }
}

/* ===== Revert decoding (custom errors → thông điệp đẹp) ===== */
function parseRevertMessage(e){
  try{
    const data = e?.data || e?.info?.error?.data || e?.error?.data;
    if(!data || typeof data!=="string") return null;
    const iface = new ethers.Interface(LOTO_ABI);
    const parsed = iface.parseError(data);
    if(!parsed) return null;
    switch(parsed.name){
      case "PausedError":           return "Game is currently paused.";
      case "InvalidInput":          return "Invalid input (check numbers & stakes).";
      case "DuplicateNumber":       return "Duplicate numbers are not allowed.";
      case "BelowMinBet":           return `Each stake must be ≥ ${fmtUnits(minBetWei)} FROLL.`;
      case "InsufficientAllowance": return "Allowance is insufficient. Please approve enough FROLL and try again.";
      case "InsufficientLiquidity": return "Contract pool cannot cover worst-case payout. Try lowering your max stake.";
      default: return `Reverted: ${parsed.name}`;
    }
  }catch{}
  return e?.shortMessage || e?.reason || e?.message || null;
}

/* ===== Place Bet ===== */
async function placeBet(){
  try{
    if(!signer){ toast("Please connect your wallet first."); return; }
    const {numbers, stakes} = collectBets();

    // Save for Repeat (store stakes as FROLL string)
    lastBets = { numbers: numbers.slice(), stakes: stakes.map(bi=>fmtUnits(bi)) };

    let total=0n; for(const s of stakes) total+=s;
    if(total<=0n){ toast("Total stake must be > 0."); return; }

    const betType = document.querySelector('input[name="bet-type"]:checked')?.value || "lucky27";

    await preflightLiquidity(stakes, betType);
    await ensureAllowance(total);

    const method = (betType === "matchup") ? "betDe" : "betLo";
    toast("Sending bet transaction...");

    // Gas: estimate + fast overrides (+20% buffer)
    const feeOv  = await getFastOverrides();
    let gasEst;
    try { gasEst = await lotto[method].estimateGas(numbers, stakes, feeOv); }
    catch { try { gasEst = await lotto[method].estimateGas(numbers, stakes); } catch {} }
    const tx = await lotto[method](numbers, stakes, {
      ...feeOv,
      ...(gasEst ? { gasLimit: (gasEst * 12n) / 10n } : {})
    });

    // === Bet Status: show per-number stakes ===
    const pairs = numbers.map((n,i)=> `${String(n).padStart(2,"0")}: ${fmt(fmtUnits(stakes[i]))} FROLL`);
    $("#last-bet-numbers").textContent = pairs.join("; ");
    $("#last-bet-stake").textContent   = `${fmt(fmtUnits(total))} FROLL`;
    $("#last-bet-result").textContent  = "Waiting for confirmation...";
    $("#last-win-status").textContent  = "No win/loss yet";

    const rc = await tx.wait();

    // Parse logs → result
    let win=false, resultText="";
    try{
      const iface = new ethers.Interface(LOTO_ABI);
      for(const log of rc.logs || []){
        try{
          const p = iface.parseLog(log);
          if(p?.name==="BetLoSettled"){
            const draws = p.args.draws.map(x=>Number(x));
            const gross = p.args.grossPayout;
            resultText = `Draws: ${draws.map(x=>String(x).padStart(2,"0")).join(", ")} | Payout: ${fmt(fmtUnits(gross))} FROLL`;
            win = (gross > 0n);
          }else if(p?.name==="BetDeSettled"){
            const draw  = Number(p.args.draw);
            const gross = p.args.grossPayout;
            resultText = `Draw: ${String(draw).padStart(2,"0")} | Payout: ${fmt(fmtUnits(gross))} FROLL`;
            win = (gross > 0n);
          }
        }catch{/* ignore */}
      }
    }catch(e){ console.warn("Parse logs failed:", e); }

    $("#last-bet-result").textContent = resultText || `Confirmed in block ${rc.blockNumber}.`;
    const winEl = $("#last-win-status");
    winEl.textContent = win ? "WIN" : "LOSE";
    winEl.classList.toggle("win",  win);
    winEl.classList.toggle("lose", !win);

    toast(`Bet confirmed. Tx: ${EXPLORER}/tx/${tx.hash}`);
    await refreshBalances();
  }catch(e){
    console.error(e);
    const nice = parseRevertMessage(e);
    toast(nice || "Bet failed.");
  }
}

/* ===== Lucky Picks (suggestion only) ===== */
function luckyGenerate(){
  const countEl = $("#lucky-count");
  const previewEl = $("#lucky-preview");
  if(!countEl || !previewEl) return;

  let n = Math.floor(Number(countEl.value || "0"));
  if(!Number.isFinite(n) || n<1) n=1;
  if(n>99) n=99;

  const set = new Set();
  while(set.size < n) set.add(Math.floor(Math.random()*100));

  const arr = Array.from(set).sort((a,b)=>a-b).map(x=>String(x).padStart(2,"0"));
  previewEl.textContent = `Lucky numbers (reference only): ${arr.join(", ")}`;
}

/* ===== Decode Event Data ===== */
// Helper: lấy tx hash từ chuỗi nhập (tx hash thuần hoặc link VicScan)
function extractTxHash(input) {
  if (!input) return null;
  const m = String(input).match(/0x[0-9a-fA-F]{64}/);
  return m ? m[0] : null;
}

function autoResizeTextarea(el){
  if(!el) return;
  el.style.height="auto";
  el.style.height=(el.scrollHeight+4)+"px";
}

// Accept: tx hash / VicScan URL / raw hex data
async function decodeEventData(){
  const elIn  = $("#decode-input");
  const elOut = $("#decode-output");
  if (!elIn || !elOut) return;

  try {
    const raw = (elIn.value || "").trim();
    if (!raw) throw new Error("Please paste data or a tx hash / link.");

    // A) TX HASH or VicScan link → parse both Played & Settled (đủ thông tin)
    const maybeHash = extractTxHash(raw);
    if (maybeHash && raw.length <= 200) {
      const ro = provider ?? new ethers.JsonRpcProvider(RPC_URL);
      const rc = await ro.getTransactionReceipt(maybeHash);
      if (!rc) throw new Error("Transaction not found. Please check the hash/link.");

      const iface = new ethers.Interface(LOTO_ABI);
      let played = null, settled = null;

      for (const log of rc.logs || []) {
        if ((log.address || "").toLowerCase() !== LOTO_ADDR.toLowerCase()) continue;
        try {
          const p = iface.parseLog(log);
          if (p?.name === "BetLoPlayed" || p?.name === "BetDePlayed")  played  = p;
          if (p?.name === "BetLoSettled" || p?.name === "BetDeSettled") settled = p;
        } catch {}
      }

      let html = `<strong>Decoded (From Tx)</strong><br/>Tx: <a href="${EXPLORER}/tx/${maybeHash}" target="_blank">${maybeHash}</a><br/>`;

      if (played) {
        const nums   = Array.from(played.args.numbers).map(n => Number(n));
        const stakes = Array.from(played.args.stakes).map(bi => ethers.toBigInt(bi));
        const total  = ethers.toBigInt(played.args.totalStake);
        const pairs  = nums.map((n,i)=> `${String(n).padStart(2,"0")}: ${fmt(fmtUnits(stakes[i]))} FROLL`);
        html += `Bets: ${pairs.join("; ")}<br/>` +
                `Total Stake: ${fmt(fmtUnits(total))} FROLL<br/>`;
      } else {
        html += `<span class="muted">No "Played" event found in this tx.</span><br/>`;
      }

      if (settled) {
        if (settled.name === "BetLoSettled") {
          const draws  = Array.from(settled.args.draws).map(n => String(Number(n)).padStart(2,"0"));
          const payout = ethers.toBigInt(settled.args.grossPayout);
          html += `Draws: ${draws.join(", ")}<br/>` +
                  `Payout: ${fmt(fmtUnits(payout))} FROLL<br/>` +
                  `Outcome: ${payout>0n ? "WIN" : "LOSE"}`;
        } else {
          const d      = String(Number(settled.args.draw)).padStart(2,"0");
          const payout = ethers.toBigInt(settled.args.grossPayout);
          html += `Draw: ${d}<br/>` +
                  `Payout: ${fmt(fmtUnits(payout))} FROLL<br/>` +
                  `Outcome: ${payout>0n ? "WIN" : "LOSE"}`;
        }
      } else {
        html += `<span class="muted">No "Settled" event found in this tx (maybe you pasted a different tx).</span>`;
      }

      elOut.innerHTML = html;
      return;
    }

    // B) RAW HEX DATA từ tab Events
    if (!raw.startsWith("0x")) throw new Error("Please paste hex data starting with 0x, or a tx hash / link.");
    const coder = ethers.AbiCoder.defaultAbiCoder();

    // 1) Played: (uint8[] numbers, uint256[] stakes, uint256 totalStake)
    try {
      const [nums, stakes, total] = coder.decode(["uint8[]", "uint256[]", "uint256"], raw);
      const nArr   = Array.from(nums).map(n => Number(n));
      const sArr   = Array.from(stakes).map(bi => ethers.toBigInt(bi));
      const pairs  = nArr.map((n,i)=> `${String(n).padStart(2,"0")}: ${fmt(fmtUnits(sArr[i]))} FROLL`);
      elOut.innerHTML =
        `<strong>Decoded (Played)</strong><br/>` +
        `Bets: ${pairs.join("; ")}<br/>` +
        `Total Stake: ${fmt(fmtUnits(total))} FROLL<br/>` +
        `<span class="muted">Tip: For draws & payout, paste the <strong>tx hash</strong> or the <strong>data</strong> from <code>BetLoSettled</code>/<code>BetDeSettled</code>.</span>`;
      return;
    } catch (_) {}

    // 2) Lo Settled: (uint8[] draws, uint256 grossPayout, uint256 netDiff)
    try {
      const [draws, gross /*, net*/] = coder.decode(["uint8[]", "uint256", "uint256"], raw);
      const arr = Array.from(draws).map(n => String(Number(n)).padStart(2, "0"));
      const payout = ethers.toBigInt(gross);
      const isWin  = payout > 0n;
      elOut.innerHTML =
        `<strong>Decoded (Lo Settled)</strong><br/>` +
        `Draws: ${arr.join(", ")}<br/>` +
        `Payout: ${fmt(fmtUnits(payout))} FROLL<br/>` +
        `Outcome: ${isWin ? "WIN" : "LOSE"}<br/>` +
        `<span class="muted">For bet breakdown (per number), paste the tx hash or Played event data.</span>`;
      return;
    } catch (_) {}

    // 3) De Settled: (uint8 draw, uint256 grossPayout, uint256 netDiff)
    try {
      const [draw, gross /*, net*/] = coder.decode(["uint8", "uint256", "uint256"], raw);
      const d = String(Number(draw)).padStart(2, "0");
      const payout = ethers.toBigInt(gross);
      const isWin  = payout > 0n;
      elOut.innerHTML =
        `<strong>Decoded (De Settled)</strong><br/>` +
        `Draw: ${d}<br/>` +
        `Payout: ${fmt(fmtUnits(payout))} FROLL<br/>` +
        `Outcome: ${isWin ? "WIN" : "LOSE"}<br/>` +
        `<span class="muted">For bet breakdown (per number), paste the tx hash or Played event data.</span>`;
      return;
    } catch (_) {}

    throw new Error("Unrecognized input. Paste a tx hash/link, or hex `data` from one of: BetLoPlayed/BetDePlayed/BetLoSettled/BetDeSettled.");
  } catch (e) {
    elOut.textContent = e?.message || "Decode failed.";
  }
}

/* ===== Wallet events ===== */
function attachWalletEvents(){
  if(!window.ethereum) return;
  window.ethereum.on?.("accountsChanged", async (accs)=>{
    if(!accs || !accs.length){
      user=undefined;
      $("#wallet-address").textContent="";
      $("#vic-balance").textContent="—";
      $("#froll-balance").textContent="—";
      toast("Wallet disconnected.");
      return;
    }
    user = ethers.getAddress(accs[0]);
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    froll  = new ethers.Contract(FROLL_ADDR, FROLL_ABI, signer);
    lotto  = new ethers.Contract(LOTO_ADDR,  LOTO_ABI,  signer);
    $("#wallet-address").textContent = user;
    await refreshBalances();
  });

  window.ethereum.on?.("chainChanged", ()=>location.reload());
}

/* ===== UI bindings ===== */
function bindUI(){
  $("#connect-btn")?.addEventListener("click", connectWallet);
  $("#place-bet-btn")?.addEventListener("click", placeBet);
  $("#repeat-bet-btn")?.addEventListener("click", applyRepeat);
  $("#double-bet-btn")?.addEventListener("click", applyDouble);
  $("#halve-bet-btn")?.addEventListener("click", applyHalf);

  $("#lucky-generate")?.addEventListener("click", luckyGenerate);

  $("#decode-btn")?.addEventListener("click", decodeEventData);
  $("#decode-input")?.addEventListener("input", (e)=>autoResizeTextarea(e.target));

  initRows();
}

/* ===== Auto reconnect ===== */
async function autoReconnect(){
  if(!window.ethereum) return;
  try{
    await ensureChain();
    provider = new ethers.BrowserProvider(window.ethereum);
    const accs = await provider.listAccounts();
    if(accs && accs.length){
      signer = await provider.getSigner();
      user   = await signer.getAddress();
      froll  = new ethers.Contract(FROLL_ADDR, FROLL_ABI, signer);
      lotto  = new ethers.Contract(LOTO_ADDR,  LOTO_ABI,  signer);
      $("#wallet-address").textContent = user;

      try{
        const [m, d, lx, dx] = await Promise.all([
          lotto.minBet(),
          lotto.LO_DRAWS?.().catch(()=>CONST_LO_DRAWS),
          lotto.LO_PAYOUT_X?.().catch(()=>CONST_LO_X),
          lotto.DE_PAYOUT_X?.().catch(()=>CONST_DE_X)
        ]);
        minBetWei      = m ?? minBetWei;
        CONST_LO_DRAWS = d ?? CONST_LO_DRAWS;
        CONST_LO_X     = lx ?? CONST_LO_X;
        CONST_DE_X     = dx ?? CONST_DE_X;
      }catch{}

      await refreshBalances();
      toast("Wallet reconnected.");
    }
  }catch{}
}

/* ===== Boot ===== */
window.addEventListener("DOMContentLoaded", ()=>{
  bindUI();
  attachWalletEvents();
  autoReconnect();
  setInterval(()=>{ if (user) refreshBalances(); }, 30000);
});
