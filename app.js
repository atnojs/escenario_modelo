// app.js - Lógica de la aplicación con correcciones para evitar timeout (502)

// ===== INYECCIÓN GLOBAL: composePrePrompt =====
function composePrePrompt(userPrompt, ctx = {}) {
  const PRE = [
    "Photorealistic rendering with premium catalog quality.",
    "Soft diffused daylight, balanced exposure, neutral-warm white balance.",
    "Filmic soft S-curve: rich blacks, smooth highlight roll-off, gentle midtone contrast.",
    "Perceived gamma around 1.03; micro-sharpening only, no halos.",
    "Cinematic depth of field with natural bokeh.",
    "No text, no extra objects, no watermarks.",
    "If a base image is provided, strictly preserve existing logos and brand marks.",
    "Camera reference: Phase One IQ4 150MP."
  ].join(" ");
  const INTEGRATION = ctx.integration === true
    ? "Photorealistic compositing of provided assets: use scenario as background plate; synthesize the model with coherent pose and skin tones; transfer garment onto the model with physically plausible cloth drape and occlusions; attach accessory with correct scale, reflections and contact shadows; match lighting and color temperature to the scenario; unify grade with the filmic profile."
    : "";
  return [PRE, INTEGRATION, userPrompt || ""].map(s => String(s||"").trim()).filter(Boolean).join(" ");
}

// ===== INYECCIÓN GLOBAL: postProcessDataURL (OBLIGATORIO) =====
async function postProcessDataURL(dataURL, opts = {}) {
  // Verificación de seguridad por si dataURL no es válido
  if (!dataURL || typeof dataURL !== 'string' || !dataURL.startsWith('data:image')) {
      console.warn("postProcessDataURL recibió datos inválidos", dataURL);
      return dataURL; 
  }

  const cfg = Object.assign({
    gamma: 1.015,
    sCurve: 0.20,
    sat: 1.02,
    warmHi: 0.10,
    unsharpAmt: 0.22,
    unsharpRadius: 1.4
  }, opts);

  try {
    const img = await new Promise((res, rej) => {
        const im = new Image(); 
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im); 
        im.onerror = (e) => rej(e); 
        im.src = dataURL;
    });
    
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h);

    const id = x.getImageData(0, 0, w, h), d = id.data;
    const pow = (v,g)=>Math.pow(Math.max(0,Math.min(1,v)),1/g);
    const sCurve = (v,k)=>{ const X=v-0.5; return Math.max(0,Math.min(1,0.5+(X*(1+k))/(1+k*Math.abs(X)*2))); };
    const clamp = v => v<0?0:v>255?255:v;

    for (let i=0;i<d.length;i+=4){
        let r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255;
        const Y = 0.2627*r + 0.678*g + 0.0593*b;
        r=sCurve(pow(r,cfg.gamma),cfg.sCurve);
        g=sCurve(pow(g,cfg.gamma),cfg.sCurve);
        b=sCurve(pow(b,cfg.gamma),cfg.sCurve);
        const mean=(r+g+b)/3; const k=cfg.sat-1;
        r=mean+(r-mean)*(1+k); g=mean+(g-mean)*(1+k); b=mean+(b-mean)*(1+k);
        if (Y>0.6){ const wamt=cfg.warmHi*(Y-0.6)/0.4; r+=0.8*wamt; b-=0.8*wamt; }
        d[i]=clamp(r*255); d[i+1]=clamp(g*255); d[i+2]=clamp(b*255);
    }
    x.putImageData(id,0,0);

    if (cfg.unsharpAmt>0){
        const bc=document.createElement('canvas'); bc.width=w; bc.height=h;
        const bx=bc.getContext('2d'); bx.filter=`blur(${cfg.unsharpRadius}px)`; bx.drawImage(c,0,0);
        const src=x.getImageData(0,0,w,h), blr=bx.getImageData(0,0,w,h);
        const sd=src.data, bd=blr.data;
        for (let i=0;i<sd.length;i+=4){
        sd[i]   = clamp(sd[i]   + (sd[i]   - bd[i])   * cfg.unsharpAmt);
        sd[i+1] = clamp(sd[i+1] + (sd[i+1] - bd[i+1]) * cfg.unsharpAmt);
        sd[i+2] = clamp(sd[i+2] + (sd[i+2] - bd[i+2]) * cfg.unsharpAmt);
        }
        x.putImageData(src,0,0);
    }
    return c.toDataURL('image/jpeg', 0.95);
  } catch (e) {
      console.error("Error en post-procesado:", e);
      return dataURL; // Devolver original si falla el procesado
  }
}

// Variables globales
let uploadedImages = { scenario: null, model: null, clothing: null, accessory: null };
let selectedCompositions = [];
let currentBox = null;
let generatedImages = []; 

// Elementos del DOM
const fileInput = document.getElementById('file-input');
const generateBtn = document.getElementById('generate-btn');
const styleSelect = document.getElementById('style-select');
const selectionInfo = document.getElementById('selection-info');
const resultsSection = document.getElementById('results-section');
const resultsGrid = document.getElementById('results-grid');
const loadingElement = document.getElementById('loading');
const loadingText = loadingElement.querySelector('p');
const downloadAllBtn = document.getElementById('download-all');
const newCompositionBtn = document.getElementById('new-composition');

// Selectores
const compSelectA = document.getElementById('comp-select-a');
const compSelectB = document.getElementById('comp-select-b');
const compSelectC = document.getElementById('comp-select-c');

// --- DATOS DE COMPOSICIONES ---
const COMPOSITION_MAP = {
  artistic: { title: 'Composición Artística Publicitaria', description: 'Una imagen con composición artística e intención publicitaria.' },
  expositive: { title: 'Composición Expositiva', description: 'Una imagen más ordenada que permite identificar claramente los elementos.' },
  social: { title: 'Publicación para Redes Sociales', description: 'Formato vertical 9:16 optimizado para Instagram, TikTok, etc.' },
  product: { title: 'Bodegón de Producto (Flat Lay)', description: 'Enfoque en los productos sin distracciones del modelo.' },
  behind: { title: 'Estilo "Entre Bastidores"', description: 'Una toma cándida que muestra un momento natural durante la sesión.' },
  banner: { title: 'Banner Publicitario Horizontal', description: 'Formato panorámico con espacio para logo y eslogan.' },
  cinematic: { title: 'Composición Cinematográfica', description: 'Imagen con encuadre y estética de cine, usando iluminación dramática y narrativa visual.' },
  minimalist: { title: 'Composición Minimalista', description: 'Diseño limpio con pocos elementos que resaltan el producto o mensaje principal.' },
  luxury: { title: 'Composición de Lujo', description: 'Visuales premium con acabados brillantes y materiales de alta gama para transmitir exclusividad.' },
  editorial: { title: 'Estilo Editorial', description: 'Inspirado en revistas de moda y diseño, con tipografía integrada a la imagen.' },
  conceptual: { title: 'Composición Conceptual', description: 'Imágenes abstractas o metafóricas que transmiten una idea más que mostrar el producto.' },
  immersive: { title: 'Composición Inmersiva 3D', description: 'Diseños con perspectiva envolvente o simulación 3D para captar atención.' },
  retro: { title: 'Estilo Retro Vintage', description: 'Composición con estética de décadas pasadas, colores y tipografías clásicas.' },
  dynamic: { title: 'Composición Dinámica', description: 'Uso de movimiento, diagonales y superposición de elementos para energía y acción.' },
  testimonial: { title: 'Estilo Testimonial', description: 'Imagen con persona real usando el producto, transmitiendo confianza y autenticidad.' },
  futuristic: { title: 'Composición Futurista', description: 'Visuales vanguardistas con estética tecnológica, hologramas y luces de neón.' },
  abstract: { title: 'Composición Abstracta', description: 'Formas y colores no figurativos que crean impacto visual sin mostrar directamente el producto.' },
  collage: { title: 'Composición Collage', description: 'Superposición de fotos, texturas y recortes gráficos para un estilo artístico y llamativo.' },
  geometric: { title: 'Composición Geométrica', description: 'Uso de líneas y figuras geométricas para dar estructura y modernidad a la imagen.' },
  organic: { title: 'Composición Orgánica', description: 'Formas fluidas e irregulares que transmiten naturalidad y cercanía.' },
  contrast: { title: 'Composición de Contraste', description: 'Colores, luces y texturas opuestas para resaltar el mensaje o producto.' },
  storytelling: { title: 'Narrativa Visual', description: 'Imagen que cuenta una historia breve alrededor del producto o marca.' },
  urban: { title: 'Estilo Urbano', description: 'Fotografía en escenarios de ciudad, transmitiendo dinamismo y modernidad.' },
  natural: { title: 'Composición Naturalista', description: 'Producto integrado en entornos naturales con iluminación realista.' },
  macro: { title: 'Detalle Macro', description: 'Primerísimo plano que resalta texturas y detalles invisibles a simple vista.' },
  panoramic: { title: 'Composición Panorámica', description: 'Fotografía amplia que sitúa al producto en un contexto mayor.' },
  split: { title: 'Composición Dividida', description: 'Pantalla o cartel partido en dos secciones contrastadas que refuerzan el mensaje.' },
  typographic: { title: 'Composición Tipográfica', description: 'Texto como elemento visual central, integrado con imágenes de apoyo.' },
  surreal: { title: 'Composición Surrealista', description: 'Escenas oníricas y fuera de lo común que sorprenden al espectador.' },
  flatcolor: { title: 'Estilo Flat Color', description: 'Uso de colores planos y brillantes con mínima textura para resaltar simplicidad.' },
  gradient: { title: 'Composición con Degradados', description: 'Fondos y elementos con transiciones suaves de color para dar modernidad.' },
  handcrafted: { title: 'Estilo Artesanal', description: 'Elementos dibujados a mano, pinceladas o texturas craft que transmiten autenticidad.' },
  interactive: { title: 'Composición Interactiva', description: 'Diseños pensados para pantallas con elementos que sugieren movimiento o acción.' },
  monochrome: { title: 'Composición Monocromática', description: 'Uso de una sola gama de color para uniformidad y sofisticación.' },
  collaborative: { title: 'Estilo Colaborativo', description: 'Imágenes que muestran interacción entre varias personas usando el producto.' },
  seasonal: { title: 'Composición Estacional', description: 'Visuales adaptados a una estación del año o festividad específica.' }
};

const GROUPS = {
  A: ['expositive', 'product', 'behind', 'banner', 'testimonial', 'urban', 'natural', 'macro', 'panoramic', 'split', 'editorial', 'luxury'],
  B: ['cinematic', 'minimalist', 'dynamic', 'immersive', 'futuristic', 'retro', 'gradient', 'flatcolor', 'geometric', 'organic', 'monochrome', 'seasonal'],
  C: ['artistic', 'conceptual', 'abstract', 'collage', 'typographic', 'storytelling', 'surreal', 'interactive', 'contrast', 'handcrafted', 'social', 'collaborative']
};

// --- INICIALIZACIÓN DE LA APP ---
document.addEventListener('DOMContentLoaded', () => {
  initDragAndDrop();
  initThreeSelects();
  attachSelectEvents();
  checkGenerateButtonState();
  initCustomSelects();

  generateBtn.addEventListener('click', generateImages);
  downloadAllBtn.addEventListener('click', downloadAllImages);
  newCompositionBtn.addEventListener('click', resetComposition);

  const modal = document.getElementById('image-modal');
  const modalClose = document.querySelector('.modal-close');
  if(modalClose) modalClose.addEventListener('click', () => { modal.style.display = 'none'; });
  if(modal) modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
  
  // contenedor de tags
  document.querySelectorAll('.select-group').forEach(group => {
    const container = document.createElement('div');
    container.className = 'cs-tags-container';
    group.appendChild(container);
  });

  const container = document.querySelector('.container');
  if(container) container.addEventListener('click', handleTagDeletion);
  updateAllTagsUI();
});

// --- LÓGICA PRINCIPAL ---

function initDragAndDrop() {
  const boxes = document.querySelectorAll('.upload-box');
  boxes.forEach(box => {
    box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag-over'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag-over'));
    box.addEventListener('drop', e => {
      e.preventDefault(); box.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) handleImageUpload(e.dataTransfer.files[0], box.id);
    });
    box.addEventListener('click', () => { currentBox = box.id; fileInput.click(); });
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0 && currentBox) {
      handleImageUpload(fileInput.files[0], currentBox);
      fileInput.value = '';
      currentBox = null;
    }
  });
}

function handleImageUpload(file, boxId) {
  if (!file.type.startsWith('image/')) { alert('Por favor, sube solo archivos de imagen.'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    const imageType = boxId.split('-')[0];
    uploadedImages[imageType] = file;
    const previewElement = document.getElementById(`${imageType}-preview`);
    if (previewElement) {
      previewElement.src = e.target.result;
      previewElement.style.display = 'block';
    }
    checkGenerateButtonState();
  };
  reader.readAsDataURL(file);
}

function initThreeSelects() {
  populateSelect(compSelectA, GROUPS.A);
  populateSelect(compSelectB, GROUPS.B);
  populateSelect(compSelectC, GROUPS.C);
  updateOptionChecks();
}

function populateSelect(selectEl, keys) {
  if (!selectEl) return;
  keys.forEach(k => {
    const opt = document.createElement('option');
    opt.value = k;
    opt.dataset.label = COMPOSITION_MAP[k]?.title || k;
    opt.textContent = opt.dataset.label;
    selectEl.appendChild(opt);
  });
}

function attachSelectEvents() {
  const handleCompositionChange = () => {
    const selections = new Map();
    [compSelectA, compSelectB, compSelectC].forEach(sel => {
      if (sel.value) {
        if (selections.has(sel.value)) {
          sel.value = '';
        } else {
          selections.set(sel.value, sel.id);
        }
      }
    });

    selectedCompositions = Array.from(selections.keys());
    selectionInfo.textContent = `Seleccionados: ${selectedCompositions.length}/3`;
    updateOptionChecks();
    checkGenerateButtonState();
    updateAllTagsUI();
    refreshCustomSelects();
  };

  [styleSelect, compSelectA, compSelectB, compSelectC].forEach(sel => {
    if (!sel) return;
    sel.addEventListener('change', () => {
      if (sel.id === 'style-select') {
        checkGenerateButtonState();
        updateAllTagsUI();
      } else {
        handleCompositionChange();
      }
    });
  });
}

function updateOptionChecks() {
  [compSelectA, compSelectB, compSelectC].forEach(sel => {
    if (!sel) return;
    for (const opt of sel.options) {
      if (opt.value === '') continue;
      const baseLabel = opt.dataset.label || opt.textContent.replace(/^✓\s*/, '');
      opt.dataset.label = baseLabel;
      opt.textContent = selectedCompositions.includes(opt.value) ? `✓ ${baseLabel}` : baseLabel;
    }
  });
}

function checkGenerateButtonState() {
  const uploadedCount = Object.values(uploadedImages).filter(Boolean).length;
  generateBtn.disabled = !(uploadedCount >= 1 && styleSelect.value && selectedCompositions.length > 0);
}

// --- GENERACIÓN DE IMÁGENES ---
async function generateImages() {
  if (generateBtn.disabled) return;

  const numVariants = 2;
  const totalImages = Math.min(selectedCompositions.length * numVariants, 6);
  let currentImage = 0;

  loadingElement.style.display = 'block';
  generateBtn.disabled = true;
  downloadAllBtn.disabled = true;
  loadingText.textContent = `Preparando para generar ${totalImages} imágenes...`;
  resultsSection.classList.add('active');
  resultsSection.scrollIntoView({ behavior: 'smooth' });

  try {
    for (const comp of selectedCompositions) {
      for (let v = 1; v <= numVariants; v++) {
        if (currentImage >= totalImages) break;
        currentImage++;
        loadingText.textContent = `Generando imagen ${currentImage} de ${totalImages}...`;

        const formData = new FormData();
        formData.append('style', styleSelect.value);
        formData.append('compositions', JSON.stringify([comp])); // Enviamos UNA composición a la vez para evitar 502
        
        // Metadatos de composición + instrucción creativa
        const originalCompMeta = COMPOSITION_MAP[comp];
        const creativeInstruction = "CRITICAL INSTRUCTION: As a creative director, your task is to generate a completely unique and novel image concept. You MUST NOT repeat poses, camera angles, lighting, or compositions from previous generations.";
        const compMeta = { 
          [comp]: { 
            ...originalCompMeta,
            description: `${originalCompMeta?.description || ''}. ${creativeInstruction}`
          } 
        };
        formData.append('composition_meta', JSON.stringify(compMeta));
        formData.append('variant', v);
        formData.append('seed', Date.now() + Math.random());

        // ===== PREPROMPT + CONTEXTO DE INTEGRACIÓN =====
        const hasScenario = !!uploadedImages.scenario;
        const hasModel = !!uploadedImages.model;
        const hasGarment = !!uploadedImages.clothing;
        const hasAccessory = !!uploadedImages.accessory;

        const styleName = styleSelect.options[styleSelect.selectedIndex]?.textContent || styleSelect.value || 'Estilo';
        const compTitle = originalCompMeta?.title || comp;
        const compDesc = originalCompMeta?.description || '';
        const userPrompt = [
          `Style: ${styleName}.`,
          `Composition: ${compTitle}.`,
          compDesc
        ].join(' ');

        const integrationFlag = (hasScenario && hasModel && hasGarment && hasAccessory) === true;
        const finalPrompt = composePrePrompt(userPrompt, { integration: integrationFlag });
        formData.append('finalPrompt', finalPrompt);

        // Mapeo de parts en orden [scenario(base), model(ref), clothing(ref), accessory(ref)]
        const orderedKeys = ['scenario', 'model', 'clothing', 'accessory'];
        orderedKeys.forEach(key => {
          const file = uploadedImages[key];
          if (file) formData.append(key, file);
        });

        // Llamada real al proxy
        const response = await fetch('proxy.php', {
          method: 'POST',
          body: formData
        });

        // Manejo de errores 502/500
        if (!response.ok) {
          const statusText = response.status === 502 ? "Timeout / Error de Servidor (502)" : response.status;
          console.error(`Error HTTP para ${comp} v${v}: ${response.status}`);
          // No mostramos alert para no bloquear el flujo si solo falla una, pero lo logueamos
          // alert(`Error al generar la imagen para ${comp} (variante ${v}). Código: ${statusText}`);
          continue; 
        }

        const data = await response.json();

        if (data.success && data.images && data.images[comp]) {
          const raw = data.images[comp];
          // Verificamos si vino imagen o texto de error
          if(raw.error) {
             console.error(`API Error for ${comp}: ${raw.error}`);
             continue;
          }
          
          let srcRaw = null;
          if (raw.mimeType && raw.image) {
            srcRaw = `data:${raw.mimeType};base64,${raw.image}`;
          } else if (typeof raw === 'string' && raw.startsWith('data:')) {
            srcRaw = raw;
          }

          if (srcRaw) {
              const src = await postProcessDataURL(srcRaw); // post-procesado
              const imgKey = `${comp}_${v}`;
              const imgObj = { key: imgKey, data: src };
              generatedImages.unshift(imgObj);
              addResultCard(imgObj.key, imgObj.data);
          } else {
               console.warn("La respuesta no contenía datos de imagen válidos", raw);
          }

        } else {
          console.error(`Error del servidor para ${comp} v${v}:`, data.error || 'Respuesta inválida');
        }
        
        checkDownloadAllState();
      }
    }
  } catch (error) {
    console.error('Error de conexión o en la generación de imágenes:', error);
    alert(`Ocurrió un error de conexión. Asegúrate de que el servidor (proxy.php) está funcionando. Error: ${error.message}`);
  } finally {
    loadingElement.style.display = 'none';
    generateBtn.disabled = false;
  }
}


// --- GESTIÓN DE RESULTADOS ---

function addResultCard(compKey, imgData) {
  const match = compKey.match(/^(.*)_(\d+)$/);
  const baseKey = match ? match[1] : compKey;
  const variantNum = match ? match[2] : '1';
  const variantText = parseInt(variantNum) > 1 ? ` (Variante ${variantNum})` : '';
  const card = document.createElement('div');
  card.className = 'result-card animate-in';
  card.dataset.key = compKey;
  const filename = `${baseKey.replace(/[^a-z0-9]/gi, '-')}_variant${variantNum}.png`;
  
  // Seguridad XSS en href
  const safeTitle = (COMPOSITION_MAP[baseKey]?.title || baseKey).replace(/"/g, '&quot;');
  
  card.innerHTML = `
    <img src="${imgData}" class="result-image" alt="Resultado ${safeTitle}" onclick="openModal(this.src)">
    <div class="result-info">
      <h3>${safeTitle}${variantText}</h3>
      <p>${COMPOSITION_MAP[baseKey]?.description || 'Composición generada.'}</p>
      <a href="${imgData}" download="${filename}" class="download-btn">Descargar PNG</a>
      <button class="delete-btn" onclick="deleteImage(this)" aria-label="Eliminar">&times;</button>
    </div>
  `;
  resultsGrid.insertBefore(card, resultsGrid.firstChild);
  setTimeout(() => card.classList.remove('animate-in'), 300);
}

function deleteImage(buttonEl) {
  const card = buttonEl.closest('.result-card');
  if (!card) return;

  const compKey = card.dataset.key;
  if (compKey) {
    generatedImages = generatedImages.filter(img => img.key !== compKey);
  }
  
  card.remove();
  checkDownloadAllState();
}

function openModal(src) {
  const modal = document.getElementById('image-modal');
  const modalImg = document.getElementById('modal-image');
  if(modalImg && modal) {
      modalImg.src = src;
      modal.style.display = 'flex';
  }
}

async function downloadAllImages() {
  if (generatedImages.length === 0) {
    alert('No hay imágenes generadas para descargar.');
    return;
  }
  if (typeof JSZip === 'undefined') {
    alert('Error: La librería JSZip no está disponible. Recarga la página.');
    return;
  }

  const zip = new JSZip();
  let validCount = 0;

  for (const imgObj of generatedImages) {
    const { key, data } = imgObj;
    if (typeof data !== 'string' || !data.startsWith('data:image/')) continue;

    try {
      const base64Data = data.split(',')[1];
      const match = key.match(/^(.*)_(\d+)$/);
      const baseKey = match ? match[1] : key;
      const variantNum = match ? match[2] : '1';
      const filename = `${baseKey.replace(/[^a-z0-9]/gi, '-')}_variant${variantNum}.png`;
      zip.file(filename, base64Data, { base64: true });
      validCount++;
    } catch (error) {
      console.error(`Error procesando la imagen ${key}:`, error);
    }
  }

  if (validCount === 0) {
    alert('No se encontraron imágenes válidas para descargar.');
    return;
  }

  try {
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `composiciones_${new Date().toISOString().split('T')[0]}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error('Error generando el ZIP:', error);
    alert(`Error al generar el archivo ZIP: ${error.message}`);
  }
}

function checkDownloadAllState() {
  downloadAllBtn.disabled = resultsGrid.children.length === 0;
}

function resetComposition() {
  uploadedImages = { scenario: null, model: null, clothing: null, accessory: null };
  document.querySelectorAll('.preview-image').forEach(p => { p.src = ''; p.style.display = 'none'; });
  [styleSelect, compSelectA, compSelectB, compSelectC].forEach(sel => { if(sel) sel.value = ''; });
  selectedCompositions = [];
  generatedImages = [];
  selectionInfo.textContent = 'Seleccionados: 0/3';
  updateOptionChecks();
  updateAllTagsUI();
  resultsSection.classList.remove('active');
  resultsGrid.innerHTML = '';
  downloadAllBtn.disabled = true;
  checkGenerateButtonState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- LÓGICA DE TAGS DE SELECCIÓN ---
function updateAllTagsUI() {
  [styleSelect, compSelectA, compSelectB, compSelectC].forEach(sel => {
    if (!sel) return;
    const group = sel.closest('.select-group, .selectors-grid');
    const container = group.querySelector('.cs-tags-container');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (sel.value) {
      const selectedOption = sel.options[sel.selectedIndex];
      if (!selectedOption || selectedOption.value === '') return;

      const tag = document.createElement('div');
      tag.className = 'cs-tag';
      
      const tagName = selectedOption.textContent.replace(/^✓\s*/, '');
      tag.innerHTML = `
        <span>${tagName}</span>
        <button class="cs-tag-delete" data-select-id="${sel.id}" aria-label="Eliminar selección">&times;</button>
      `;
      
      container.appendChild(tag);
    }
  });
}

function handleTagDeletion(e) {
  if (!e.target.matches('.cs-tag-delete')) return;
  
  const selectId = e.target.dataset.selectId;
  const selectToClear = document.getElementById(selectId);
  
  if (selectToClear) {
    selectToClear.value = '';
    selectToClear.dispatchEvent(new Event('change', { bubbles: true }));
  }
}


// --- LÓGICA DE SELECTORES PERSONALIZADOS ---
let csLayer;
function initCustomSelects() {
  csLayer = document.createElement('div');
  csLayer.id = 'cs-layer';
  csLayer.className = 'cs-layer';
  document.body.appendChild(csLayer);
  enhanceAllSelects();
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.cs-btn, .cs-popup')) closeAllLists();
  }, true);
}
function enhanceAllSelects() { document.querySelectorAll('select:not([data-cs-enhanced])').forEach(enhanceSelect); }
function enhanceSelect(sel) {
  if (sel.dataset.csEnhanced) return;
  sel.dataset.csEnhanced = 'true';
  sel.classList.add('visually-hidden');
  const wrap = document.createElement('div');
  wrap.className = 'cs';
  wrap.dataset.for = sel.id;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cs-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'cs-label';
  label.textContent = sel.options[sel.selectedIndex]?.textContent || 'Elige una opción';
  const svgIcon = `<svg viewBox='0 0 24 24' width='20' height='20' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round'><path d='M6 9l6 6 6-6'/></svg>`;
  btn.innerHTML = `<span class="cs-label">${label.textContent}</span>${svgIcon}`;
  const list = document.createElement('ul');
  list.className = 'cs-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  wrap.cs = { list, sel, btn };
  sel.insertAdjacentElement('afterend', wrap);
  wrap.appendChild(btn);
  btn.addEventListener('click', () => {
    const isOpening = btn.getAttribute('aria-expanded') === 'false';
    closeAllLists();
    if (isOpening) toggleList(wrap, true);
  });
}
function refreshCustomSelects() {
  document.querySelectorAll('.cs').forEach(wrap => {
    if (!wrap.cs) return;
    const { sel, btn } = wrap.cs;
    const selectedOption = sel.options[sel.selectedIndex];
    const labelEl = btn.querySelector('.cs-label');
    if (labelEl) labelEl.textContent = selectedOption ? selectedOption.textContent.replace(/^✓\s*/, '') : 'Elige una opción';
  });
}
function rebuildList(wrap) {
  const { list, sel } = wrap.cs;
  list.innerHTML = '';
  Array.from(sel.options).forEach(opt => {
    const li = document.createElement('li');
    li.className = 'cs-option' + (opt.value === '' ? ' is-none' : '');
    li.setAttribute('role', 'option');
    li.dataset.value = opt.value;
    li.textContent = opt.textContent.replace(/^✓\s*/, '');
    if (sel.value === opt.value) {
      li.classList.add('selected');
      li.setAttribute('aria-selected', 'true');
    }
    list.appendChild(li);
  });
  list.removeEventListener('click', handleOptionClick);
  list.addEventListener('click', handleOptionClick);
}
function handleOptionClick(e) {
  const item = e.target.closest('.cs-option');
  if (!item) return;
  const list = e.currentTarget;
  const wrap = list.csWrap;
  const { sel } = wrap.cs;
  if (sel.value !== item.dataset.value) {
    sel.value = item.dataset.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  toggleList(wrap, false);
}
function toggleList(wrap, open) {
  const { btn, list } = wrap.cs;
  btn.setAttribute('aria-expanded', String(open));
  if (open) {
    rebuildList(wrap);
    list.classList.add('cs-popup');
    list.csWrap = wrap;
    csLayer.appendChild(list);
    positionList(btn, list);
    window.addEventListener('scroll', onRelayout, true);
    window.addEventListener('resize', onRelayout);
  } else {
    list.classList.remove('cs-popup');
    if (list.parentElement === csLayer) csLayer.removeChild(list);
    window.removeEventListener('scroll', onRelayout, true);
    window.removeEventListener('resize', onRelayout);
  }
  function onRelayout() { positionList(btn, list); }
}
function closeAllLists() { document.querySelectorAll('.cs').forEach(w => toggleList(w, false)); }
function positionList(btn, list) {
  const r = btn.getBoundingClientRect();
  const gap = 8;
  list.style.left = `${r.left}px`;
  list.style.top = `${r.bottom + gap}px`;
  list.style.minWidth = `${r.width}px`;
  const spaceBelow = window.innerHeight - (r.bottom + gap + 12);
  const spaceAbove = r.top - gap - 12;
  if (spaceBelow < 200 && spaceAbove > spaceBelow) {
    list.style.top = 'auto';
    list.style.bottom = `${window.innerHeight - r.top + gap}px`;
    list.style.maxHeight = `${spaceAbove}px`;
  } else {
    list.style.bottom = 'auto';
    list.style.top = `${r.bottom + gap}px`;
    list.style.maxHeight = `${spaceBelow}px`;
  }
}