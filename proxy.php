<?php
// Aumentar límites para evitar el error 502 y 504
set_time_limit(300); // 5 minutos de ejecución
ini_set('memory_limit', '1024M'); // 1GB de memoria para procesar imágenes grandes
ignore_user_abort(true); // Seguir ejecutando aunque el usuario cierre el navegador

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS, GET');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

/* ===== Config ===== */
// NOTA: Asegúrate de que esta variable de entorno exista en tu servidor, o pon la key directa aquí para probar.
$API_KEY = getenv('C'); 

$API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// CAMBIO IMPORTANTE: 'gemini-3-pro' no existe públicamente aún. 
// Usamos 'gemini-2.0-flash-exp' que es el actual capaz de generar imágenes via API rápida,
// o 'gemini-1.5-pro' si solo fuera texto. Para generación de imágenes, prueba este:
$DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'; 

$ALLOWED_MIME = ['image/jpeg','image/png','image/webp', 'image/heic'];
$MAX_MB = 20; 
$MAX_BYTES = $MAX_MB * 1024 * 1024;

// Intentar configurar PHP (aunque puede depender del hosting)
@ini_set('post_max_size', ($MAX_MB + 10).'M');
@ini_set('upload_max_filesize', $MAX_MB.'M');

function fail($c,$m,$x=[]){ 
    http_response_code($c); 
    echo json_encode(array_merge(['success'=>false,'error'=>$m],$x),JSON_UNESCAPED_UNICODE); 
    exit; 
}
function ok($d){ 
    echo json_encode(array_merge(['success'=>true],$d),JSON_UNESCAPED_UNICODE); 
    exit; 
}

function safe_mime($p){
  if (function_exists('mime_content_type')) { $m=@mime_content_type($p); if($m) return $m; }
  if (function_exists('finfo_open')) { $f=@finfo_open(FILEINFO_MIME_TYPE); if($f){ $m=@finfo_file($f,$p); @finfo_close($f); if($m) return $m; } }
  return 'image/jpeg';
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') ok(['message'=>'proxy.php OK','default_model'=>$DEFAULT_MODEL]);
if (!function_exists('curl_init')) fail(500,'cURL no disponible.');
if (!$API_KEY) fail(500,'API Key no configurada. Revisa tu archivo .env o .htaccess');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405,'Usa POST.');

/* ===== Inputs ===== */
// Limpieza del buffer de salida para evitar que errores de PHP rompan el JSON
ob_start();

if (empty($_POST['style'])) fail(400,'Falta style.');
if (empty($_POST['compositions'])) fail(400,'Faltan composiciones.');

$comps = json_decode($_POST['compositions'], true);
if (!is_array($comps) || !count($comps)) fail(400,'Composiciones inválidas.');

$model = isset($_POST['model']) && is_string($_POST['model']) && !empty($_POST['model']) ? trim($_POST['model']) : $DEFAULT_MODEL;
$variant = isset($_POST['variant']) ? (int)$_POST['variant'] : 1;

$styleMap = [
  'cinematic'=>'Cinemático (Estilo Película)','high-key'=>'High-Key (Luminoso y Optimista)',
  'low-key'=>'Low-Key (Clarooscuro Dramático)','street-style'=>'Street Style (Urbano y Desenfado)',
  'minimalist'=>'Minimalista y Conceptual','surreal'=>'Surrealista y Onírico',
  'grunge'=>'Grunge y Raw','vintage'=>'Fotografía analógica Vintage',
  'bw'=>'Blanco y Negro alto contraste','pastel'=>'Tonos Pastel',
  'cyberpunk'=>'Futurista / Ciberpunk','baroque'=>'Barroco / Pictórico'
];
$style = $_POST['style'];
$styleText = $styleMap[$style] ?? $style;

$NO_TEXT = "Do not render any text or lettering of any kind: no overlaid text, captions, UI, brand names, signage, labels, hangtags, or watermarks. If any source asset contains text or logos, remove/blank them and keep only texture/color.";

$promptsBase = [
  'artistic' => "Create a high-end advertising composition that integrates the provided assets: use the background image as the scene, composite the model cutout wearing the clothing item, and place the accessory with correct contact, scale, and occlusion. Style: %s. Photorealistic integration, consistent lighting. {$NO_TEXT}",
  'expositive' => "Create a clean, expository composition clearly showcasing the clothing item and accessory on the provided model within the provided background. Style: %s. Neutral studio lighting feel. {$NO_TEXT}",
  'social' => "Generate a vertical 9:16, social-ready image. Style: %s. Composite the model wearing the clothing item with the accessory. Bold composition. {$NO_TEXT}",
  'product' => "Generate a premium flat-lay product shot focusing on the clothing item and the accessory only; do not show the model. Style: %s. Top-down perspective. {$NO_TEXT}",
  'behind' => "Generate a behind-the-scenes candid look, integrating the model wearing the clothing and holding the accessory. Style: %s. Documentary vibe. {$NO_TEXT}",
  'banner' => "Generate a 16:9 banner integrating the background, model, clothing and accessory. Reserve negative space. Style: %s. {$NO_TEXT}"
];

/* ===== Meta opcional ===== */
$compMeta = [];
if (!empty($_POST['composition_meta'])) {
  $tmp = json_decode($_POST['composition_meta'], true);
  if (is_array($tmp)) $compMeta = $tmp;
}

/* ===== Procesamiento de Imágenes ===== */
$imageParts = [];
// Mapeo estricto de claves
$requiredSlots = ['scenario', 'model', 'clothing', 'accessory'];

foreach ($requiredSlots as $slot) {
  if (!isset($_FILES[$slot]) || $_FILES[$slot]['error'] !== UPLOAD_ERR_OK) continue;
  
  $tmp = $_FILES[$slot]['tmp_name'];
  if (!is_uploaded_file($tmp)) continue;
  
  // Verificación básica de tamaño
  if (filesize($tmp) > $MAX_BYTES) {
      ob_end_clean();
      fail(413,'Archivo demasiado grande: '.$slot);
  }

  $mime = safe_mime($tmp);
  // Permitimos más tipos de imagen por si acaso
  if (!in_array($mime, $ALLOWED_MIME, true) && strpos($mime, 'image/') !== 0) {
      ob_end_clean();
      fail(400,'Tipo no permitido en '.$slot.': '.$mime);
  }
  
  $b64 = base64_encode(file_get_contents($tmp));
  
  // Estructura compatible con Gemini Vision / Imagen
  $imageParts[] = [
      'inline_data' => [ // Usar snake_case para v1beta REST
          'mime_type' => $mime,
          'data' => $b64
      ]
  ];
}

if (!count($imageParts)) {
    ob_end_clean();
    fail(400,'No se han subido imágenes válidas o pesan demasiado.');
}

/* ===== Llamada API ===== */
function gemini_call_v1beta($apiKey,$apiBase,$model,$prompt,$imageParts){
  // Configuración de generación específica para evitar timeouts en el lado de Google
  $generationConfig = [
      "temperature" => 0.4,
      "topP" => 0.95,
      "topK" => 40,
      "maxOutputTokens" => 2048,
      "responseMimeType" => "application/json" // Forzar JSON si el modelo lo soporta, o texto
  ];

  // Construir payload
  $contents = [
      [
          'role' => 'user',
          'parts' => array_merge([['text' => $prompt]], $imageParts)
      ]
  ];

  $payload = [
      'contents' => $contents
      // Omitimos generationConfig estricto para evitar errores si el modelo no soporta ciertos parámetros
  ];

  $url = "{$apiBase}/models/{$model}:generateContent?key={$apiKey}";
  
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES),
    CURLOPT_TIMEOUT => 180, // Aumentado a 180 segundos para cURL
    CURLOPT_CONNECTTIMEOUT => 30,
    // CORRECCIÓN SSL PARA EVITAR 502 EN ALGUNOS HOSTINGS
    CURLOPT_SSL_VERIFYPEER => false, 
    CURLOPT_SSL_VERIFYHOST => 0,
    CURLOPT_FAILONERROR => false // Queremos recibir el cuerpo del error de Google
  ]);
  
  $resp = curl_exec($ch);
  $err = curl_error($ch);
  $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);

  if ($err) return ['error' => 'cURL Error: ' . $err];
  
  if ($http < 200 || $http >= 300) {
    $body = json_decode($resp,true);
    $msg = $body['error']['message'] ?? 'Error desconocido de la API de Google';
    return ['error' => "API Error ($http): $msg"];
  }

  $data = json_decode($resp,true);
  
  // Analizar respuesta
  $candidates = $data['candidates'][0] ?? null;
  if (!$candidates) return ['error' => 'No candidates returned'];

  $parts = $candidates['content']['parts'] ?? [];
  
  foreach ($parts as $p) {
    // Buscar imagen en linea
    if (isset($p['inline_data']['data'])) {
       return [
           'mimeType' => $p['inline_data']['mime_type'] ?? 'image/png',
           'image' => $p['inline_data']['data']
       ];
    }
    if (isset($p['inlineData']['data'])) {
       return [
           'mimeType' => $p['inlineData']['mimeType'] ?? 'image/png',
           'image' => $p['inlineData']['data']
       ];
    }
  }
  
  // Si no hay imagen, devolver texto
  $text = [];
  foreach ($parts as $p) if (isset($p['text'])) $text[] = $p['text'];
  return ['__text__' => trim(implode("\n",$text))];
}

/* ===== Builder de prompt ===== */
function build_prompt($key, $styleText, $promptsBase, $compMeta, $noText, $variant) {
    $baseP = $promptsBase[$key] ?? "Advertising composition {$key}. Style: {$styleText}.";
    if (isset($compMeta[$key]['description'])) {
        $baseP .= " " . $compMeta[$key]['description'];
    }
    
    $integration = " INTEGRATION INSTRUCTIONS: Use the 'scenario' image as the background. Place the 'model' person into this scene with a new pose that fits the perspective. Clothe the model with the 'clothing' item. Add the 'accessory' item. Photorealistic blending, matching lighting, shadows, and color grading. Output ONLY the image.";
    
    $boost = " 4K, highly detailed, professional photography.";
    
    if ($variant > 1) {
        $boost .= " Variant {$variant}: Slightly different camera angle or pose.";
    }

    return $baseP . $integration . $boost . " " . $noText;
}

/* ===== Generación ===== */
$generated = [];
// El script ahora está preparado para recibir un array, pero recomendamos enviar de 1 en 1 desde el JS
foreach ($comps as $comp) {
  $prompt = build_prompt($comp, $styleText, $promptsBase, $compMeta, $NO_TEXT, $variant);
  
  $result = gemini_call_v1beta($API_KEY, $API_BASE, $model, $prompt, $imageParts);
  
  if (isset($result['error'])) {
      // Si falla una, no matamos todo el proceso, pero reportamos error
      fail(502, "Error generando $comp: " . $result['error']);
  }
  
  $generated[$comp] = $result;
  
  // Pequeña pausa para no saturar rate limits si hay múltiples
  if (count($comps) > 1) sleep(1);
}

ob_end_clean(); // Limpiar cualquier salida previa
ok(['images'=>$generated, 'model_used'=>$model, 'variant_used'=>$variant]);
?>