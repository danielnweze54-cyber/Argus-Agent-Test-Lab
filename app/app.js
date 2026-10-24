const root=document.documentElement;
const saved=localStorage.getItem("argus-theme");
root.dataset.theme=saved||"light";
const themeToggle=document.getElementById("themeToggle"),themeSetting=document.getElementById("themeSetting");
function toggleTheme(){root.dataset.theme=root.dataset.theme==="dark"?"light":"dark";localStorage.setItem("argus-theme",root.dataset.theme)}
themeToggle.onclick=toggleTheme; themeSetting.onclick=toggleTheme;
const pages=[...document.querySelectorAll(".page")],nav=[...document.querySelectorAll("[data-page]")];
function showPage(id){pages.forEach(p=>p.classList.toggle("active",p.id===id));nav.forEach(n=>n.classList.toggle("active",n.dataset.page===id));window.scrollTo({top:0,behavior:"smooth"})}
nav.forEach(n=>n.addEventListener("click",()=>showPage(n.dataset.page)));
const modal=document.getElementById("modal");
function openModal(){modal.classList.remove("hidden")}
function closeModal(){modal.classList.add("hidden")}
document.getElementById("runTest").onclick=openModal;document.getElementById("runTest2").onclick=openModal;document.getElementById("closeModal").onclick=closeModal;
modal.querySelector(".modal-backdrop").onclick=closeModal;
document.querySelectorAll(".fault-options .chip").forEach(c=>c.onclick=()=>{document.querySelectorAll(".fault-options .chip").forEach(x=>x.classList.remove("selected"));c.classList.add("selected")});
document.querySelectorAll(".fault-row .chip").forEach(c=>c.onclick=()=>{document.querySelectorAll(".fault-row .chip").forEach(x=>x.classList.remove("selected"));c.classList.add("selected")});
document.querySelectorAll("[data-scenario]").forEach(b=>b.onclick=()=>{openModal();document.getElementById("scenarioSelect").value=b.dataset.scenario});
document.querySelectorAll("tbody tr[data-detail]").forEach(r=>r.onclick=()=>{showPage("evidence")});
document.getElementById("execute").onclick=()=>{closeModal();showPage("tests");setTimeout(()=>alert("Demo run staged as T-025. No backend call was made."),120)});
document.addEventListener("keydown",e=>{if(e.key==="Escape")closeModal()});