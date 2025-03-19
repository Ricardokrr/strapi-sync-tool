
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT =  3000;


app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


app.post('/api/auth', async (req, res) => {
  const { url, email, password, environment } = req.body;
  if (!url || !email || !password) {
    return res.status(400).json({
      error: 'Todos los campos (url, email, password) son requeridos.'
    });
  }

  try {
    let baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
    baseUrl = baseUrl.replace(/\/admin\/?$/, '');

    console.log(`Intentando login de administrador en: ${baseUrl}/admin/login`);

    const resp = await axios.post(
      `${baseUrl}/admin/login`,
      { email, password },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 10000
      }
    );

    if (!resp.data || !resp.data.data || !resp.data.data.token) {
      console.log('Respuesta inesperada:', resp.data);
      return res.status(401).json({
        error: 'No se recibió un token válido desde /admin/login'
      });
    }

    const token = resp.data.data.token;
    const adminUser = resp.data.data.user;

    const sessionId = uuidv4();
    sessions[sessionId] = {
      token,
      user: adminUser,
      baseUrl,
      environment,
      isAdmin: true
    };

    console.log(`Autenticación admin exitosa para ${email} en ${environment}`);

    return res.json({
      success: true,
      sessionId,
      user: {
        id: adminUser.id,
        username: adminUser.username || adminUser.email,
        email: adminUser.email
      },
      environment
    });
  } catch (error) {
    console.error(`Error autenticando en ${environment}:`, error.message);

    if (error.response) {
      console.error('Respuesta del servidor:', error.response.status, error.response.statusText);
      console.error('Datos de error:', error.response.data);
      let errMsg = 'Error en /admin/login';
      if (error.response.data && error.response.data.error && error.response.data.error.message) {
        errMsg = error.response.data.error.message;
      } else if (error.response.statusText) {
        errMsg = error.response.statusText;
      }
      return res.status(error.response.status).json({
        error: `Error de autenticación: ${errMsg}`
      });
    } else if (error.request) {
      console.error('No se recibió respuesta del servidor Admin');
      return res.status(503).json({ error: 'No se pudo conectar con Strapi (admin)' });
    } else {
      console.error('Error general:', error.message);
      return res.status(500).json({ error: `Error de configuración: ${error.message}` });
    }
  }
});

app.post('/api/fetch-content', async (req, res) => {
  const { sessionId, contentUrl } = req.body;
  if (!sessionId || !contentUrl) {
    return res.status(400).json({ error: 'sessionId y contentUrl son requeridos.' });
  }
  const session = sessions[sessionId];
  if (!session || !session.isAdmin) {
    return res.status(401).json({ error: 'Sesión inválida o expirada (admin).' });
  }

  try {
    // Ej: https://strapi.dev/admin/content-manager/collectionType/api::page.page/1340?plugins[i18n][locale]=en
    const matches = contentUrl.match(/collectionType\/([^/]+)\/(\d+)(\?|$)/);
    if (!matches) {
      return res.status(400).json({ error: 'No se pudo extraer UID y ID desde la URL de admin.' });
    }

    const collectionUID = matches[1]; // p.ej. api::page.page
    const contentId = matches[2];     // p.ej. 1340

    const localeParam = 'en';
    const apiUrl = `${session.baseUrl}/content-manager/collection-types/${collectionUID}/${contentId}?populate=*&plugins[i18n][locale]=${localeParam}`;

    console.log('GET:', apiUrl);

    const response = await axios.get(apiUrl, {
      headers: { Authorization: `Bearer ${session.token}` }
    });

    console.log('Respuesta de Strapi:', JSON.stringify(response.data, null, 2));

    if (!response.data || !response.data.id) {
      return res.status(404).json({ error: 'Contenido no encontrado en admin.' });
    }

    const contentData = response.data;

    const processedContent = {
      id: contentData.id,
      type: collectionUID,
      title: contentData.title || contentData.name || `ID #${contentData.id}`,
      updatedAt: contentData.updatedAt,
      localizations: [],
      components: [],
      attributes: contentData
    };

    if (contentData.localizations && contentData.localizations.locales) {
      processedContent.localizations = contentData.localizations.locales;
    }

    for (var key in contentData) {
      if (!contentData.hasOwnProperty(key)) continue;
      const val = contentData[key];
      if (val && typeof val === 'object' && val.__component) {
        processedContent.components.push({
          id: `comp_${key}`,
          type: val.__component,
          name: key,
          fields: Object.keys(val).filter(k => k !== '__component'),
          data: val
        });
      } else if (Array.isArray(val) && val.length > 0 && val[0].__component) {
        val.forEach((comp, i) => {
          processedContent.components.push({
            id: `comp_${key}_${i}`,
            type: comp.__component,
            name: `${key} #${i + 1}`,
            fields: Object.keys(comp).filter(k => k !== '__component'),
            data: comp
          });
        });
      }
    }

    return res.json(processedContent);
  } catch (error) {
    console.error('Error en /api/fetch-content:', error.message);

    if (error.response) {
      let errMsg = error.response.statusText;
      if (error.response.data && error.response.data.error && error.response.data.error.message) {
        errMsg = error.response.data.error.message;
      }
      return res.status(error.response.status).json({ error: errMsg });
    } else if (error.request) {
      return res.status(503).json({ error: 'No se obtuvo respuesta al fetch admin.' });
    } else {
      return res.status(500).json({ error: `Error: ${error.message}` });
    }
  }
});


app.post('/api/sync', async (req, res) => {
  const { sourceSessionId, destSessionId, contentId, items } = req.body;

  if (!sourceSessionId || !destSessionId || !contentId || !items || !items.length) {
    return res.status(400).json({ error: 'Faltan campos (sourceSessionId, destSessionId, contentId, items)' });
  }

  const sourceSession = sessions[sourceSessionId];
  const destSession = sessions[destSessionId];
  if (!sourceSession || !sourceSession.isAdmin || !destSession || !destSession.isAdmin) {
    return res.status(401).json({ error: 'Sesiones inválidas o no de admin.' });
  }

  const results = {
    total: items.length,
    completed: 0,
    errors: 0,
    items: []
  };

  for (const item of items) {
    try {
      if (item.type.includes('page')) {
        await syncFullPageAdmin(sourceSession, destSession, contentId, item);
      } else {
        await syncComponentAdmin(sourceSession, destSession, contentId, item);
      }
      results.completed++;
      results.items.push({
        id: item.id,
        name: item.name,
        type: item.type,
        status: 'success'
      });
    } catch (err) {
      console.error(`Error sincronizando ${item.type} ${item.id}:`, err.message);
      results.errors++;
      results.items.push({
        id: item.id,
        name: item.name,
        type: item.type,
        status: 'error',
        error: err.message
      });
    }
  }

  return res.json(results);
});


function deepCleanData(obj) {
  if (!obj || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => deepCleanData(item));
  }

  const cleanedObj = {};
  const systemFields = ['id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'];

  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;
    
    if (systemFields.includes(key) && !(obj.mime && obj.mime.startsWith('image/'))) continue;
    
    if (key === 'count' && typeof obj[key] === 'number') {
      cleanedObj[key] = obj[key];
      continue;
    }
    
    if (key === 'url' && typeof obj[key] === 'string' && isImageUrl(obj[key])) {
      cleanedObj[key] = obj[key];
      continue;
    }
    
    if ((key === 'ogImage' || key === 'image' || key === 'media' || key === 'hero') && obj[key] && typeof obj[key] === 'object') {
      cleanedObj[key] = deepCleanData(obj[key]);
      continue;
    }
    
    if (obj[key] && typeof obj[key] === 'object') {
      cleanedObj[key] = deepCleanData(obj[key]);
    } else {
      cleanedObj[key] = obj[key];
    }
  }
  
  return cleanedObj;
}


function isImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.tiff'];
  const lowerUrl = url.toLowerCase();
  return imageExtensions.some(ext => lowerUrl.endsWith(ext)) || 
         lowerUrl.includes('/images/') || 
         lowerUrl.includes('/img/') ||
         lowerUrl.includes('/uploads/');
}


async function syncFullPageAdmin(sourceSession, destSession, contentId, item) {
  const collectionUID = item.contentType;
  
  const getDevUrl = `${sourceSession.baseUrl}/content-manager/collection-types/${collectionUID}/${contentId}?populate=*&plugins[i18n][locale]=en`;
  console.log(`Obteniendo datos de origen (Dev): GET -> ${getDevUrl}`);
  
  const devRes = await axios.get(getDevUrl, {
    headers: { Authorization: `Bearer ${sourceSession.token}` }
  });
  const devData = devRes.data;
  if (!devData || !devData.id) {
    throw new Error('No se encontró la página en la fuente (Dev).');
  }
  
  console.log(`Datos de origen (Dev) para "${devData.name || 'página'}":`, JSON.stringify({
    id: devData.id,
    name: devData.name,
    uri: devData.uri
  }, null, 2));

  let existingPage = null;
  
  if (devData.uri) {
    console.log(`Buscando en Prod páginas con URI: "${devData.uri}"`);
    try {
      const searchQuery = `filters[uri][$eq]=${encodeURIComponent(devData.uri)}`;
      const findUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?${searchQuery}`;
      console.log(`Búsqueda por URI: GET -> ${findUrl}`);
      
      const findRes = await axios.get(findUrl, {
        headers: { Authorization: `Bearer ${destSession.token}` }
      });
      
      console.log('Resultado de búsqueda:', JSON.stringify({
        status: findRes.status,
        resultCount: findRes.data.results ? findRes.data.results.length : 0
      }, null, 2));
      
      const existingPages = findRes.data.results;
      if (existingPages && existingPages.length > 0) {
        existingPage = existingPages[0];
        console.log(`Encontrada página existente en Prod con URI="${devData.uri}", ID=${existingPage.id}, Nombre="${existingPage.name}"`);
      } else {
        console.log(`No se encontró página con URI="${devData.uri}" en Prod.`);
      }
    } catch (err) {
      console.log('Error buscando página existente:', err.message);
    }
  }
  
  const cleanedData = deepCleanData(devData);
  
  cleanedData.name = devData.name;
  cleanedData.uri = devData.uri;
  cleanedData.locale = 'en';
  cleanedData.publishedAt = new Date().toISOString();
  
  console.log('Iniciando procesamiento de imágenes...');
  
  if (devData.hero && Array.isArray(devData.hero) && devData.hero.length > 0) {
    console.log(`Procesando ${devData.hero.length} imágenes en campo 'hero'...`);
    cleanedData.hero = await processHeroImages(devData.hero, sourceSession, destSession);
  }
  
  await processNestedImages(cleanedData, sourceSession, destSession);
  
  console.log('Procesamiento de imágenes completado.');
  
  const directPayload = cleanedData;
  const wrappedPayload = { data: cleanedData };
  
  console.log('Campos a transferir:', Object.keys(directPayload).join(', '));
  
  if (existingPage) {
    const putUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}/${existingPage.id}?plugins[i18n][locale]=en`;
    console.log(`Actualizando página existente: PUT -> ${putUrl}`);
    
    try {
      console.log("Intentando formato #1...");
      const putRes = await axios.put(putUrl, directPayload, {
        headers: { 
          'Authorization': `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Actualización exitosa (formato #1):', JSON.stringify({
        id: putRes.data.id,
        name: putRes.data.name,
        uri: putRes.data.uri
      }, null, 2));
      
      return putRes.data;
    } catch (error) {
      console.error('Error en formato #1:', error.message);
      if (error.response) {
        console.error('Detalles del error:', JSON.stringify({
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        }, null, 2));
      }
      
      try {
        console.log("Intentando formato #2...");
        const putRes = await axios.put(putUrl, wrappedPayload, {
          headers: { 
            'Authorization': `Bearer ${destSession.token}`,
            'Content-Type': 'application/json'
          }
        });
        
        console.log('Actualización exitosa (formato #2):', JSON.stringify({
          id: putRes.data.id,
          name: putRes.data.name,
          uri: putRes.data.uri
        }, null, 2));
        
        return putRes.data;
      } catch (error2) {
        console.error('Error en formato #2:', error2.message);
        if (error2.response) {
          console.error('Detalles del error:', JSON.stringify({
            status: error2.response.status,
            statusText: error2.response.statusText,
            data: error2.response.data
          }, null, 2));
        }
        throw new Error('No se pudo actualizar la página en ningún formato');
      }
    }
  } else {
    const postUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?plugins[i18n][locale]=en`;
    console.log(`Creando nueva página: POST -> ${postUrl}`);
    
    try {
      console.log("Intentando formato #1...");
      const postRes = await axios.post(postUrl, directPayload, {
        headers: { 
          'Authorization': `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Creación exitosa (formato #1):', JSON.stringify({
        id: postRes.data.id,
        name: postRes.data.name,
        uri: postRes.data.uri
      }, null, 2));
      
      return postRes.data;
    } catch (error) {
      console.error('Error en formato #1:', error.message);
      if (error.response) {
        console.error('Detalles del error:', JSON.stringify({
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        }, null, 2));
      }
      
      try {
        console.log("Intentando formato #2...");
        const postRes = await axios.post(postUrl, wrappedPayload, {
          headers: { 
            'Authorization': `Bearer ${destSession.token}`,
            'Content-Type': 'application/json'
          }
        });
        
        console.log('Creación exitosa (formato #2):', JSON.stringify({
          id: postRes.data.id,
          name: postRes.data.name,
          uri: postRes.data.uri
        }, null, 2));
        
        return postRes.data;
      } catch (error2) {
        console.error('Error en formato #2:', error2.message);
        if (error2.response) {
          console.error('Detalles del error:', JSON.stringify({
            status: error2.response.status,
            statusText: error2.response.statusText,
            data: error2.response.data
          }, null, 2));
        }
        throw new Error('No se pudo crear la página en ningún formato');
      }
    }
  }
}


async function processHeroImages(heroImages, sourceSession, destSession) {
  const processedImages = [];
  
  for (const image of heroImages) {
    if (image && image.url) {
      try {
        console.log(`Procesando imagen hero: ${image.url}`);
        const newImage = await uploadImage(image.url, sourceSession, destSession);
        if (newImage) {
          processedImages.push(newImage);
        }
      } catch (error) {
        console.error(`Error procesando imagen hero: ${error.message}`);
      }
    }
  }
  
  return processedImages;
}


async function processNestedImages(data, sourceSession, destSession) {
  if (!data || typeof data !== 'object') return;

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      await processNestedImages(data[i], sourceSession, destSession);
    }
    return;
  }

  for (const key in data) {
    if (!data.hasOwnProperty(key)) continue;
    
    const value = data[key];
    
    if (value && typeof value === 'object' && value.url && isImageUrl(value.url)) {
      console.log(`Encontrada imagen en ${key}: ${value.url}`);
      const newImage = await uploadImage(value.url, sourceSession, destSession);
      if (newImage) {
        data[key] = newImage;
      }
      continue;
    }
    
    if (value && typeof value === 'object' && value.data && 
        value.data.attributes && value.data.attributes.url && 
        isImageUrl(value.data.attributes.url)) {
      console.log(`Encontrada referencia a imagen en ${key}: ${value.data.attributes.url}`);
      const newImage = await uploadImage(value.data.attributes.url, sourceSession, destSession);
      if (newImage) {
        data[key] = { 
          data: {
            id: newImage.id,
            attributes: { ...newImage }
          }
        };
      }
      continue;
    }
    
    if (value && typeof value === 'object') {
      await processNestedImages(value, sourceSession, destSession);
    }
  }
}


async function uploadImage(imageUrl, sourceSession, destSession) {
  try {
    if (imageUrl.startsWith('/')) {
      imageUrl = `${sourceSession.baseUrl}${imageUrl}`;
    }
    
    const imageResponse = await axios({
      method: 'get',
      url: imageUrl,
      responseType: 'arraybuffer'
    });
    
    const contentType = imageResponse.headers['content-type'];
    let extension = 'png';
    if (contentType && contentType.includes('/')) {
      extension = contentType.split('/')[1];
    }
    
    const originalExtension = path.extname(imageUrl) || `.${extension}`;
    let baseName = path.basename(imageUrl, originalExtension);
    
    const randomHash = uuidv4().slice(0, 8);
    
    const hashedFilename = `${baseName}_${randomHash}${originalExtension}`;
    
    const tempFilePath = path.join(os.tmpdir(), hashedFilename);
    fs.writeFileSync(tempFilePath, Buffer.from(imageResponse.data));
    
    console.log(`Imagen descargada y guardada en: ${tempFilePath}`);
    
    const formData = new FormData();
    formData.append('files', fs.createReadStream(tempFilePath), hashedFilename);
    
    formData.append(
      'fileInfo',
      JSON.stringify({
        name: hashedFilename,
        alternativeText: hashedFilename,
        caption: hashedFilename
      })
    );
    
    const uploadUrl = `${destSession.baseUrl}/upload`;
    console.log(`Subiendo imagen a: ${uploadUrl}`);
    
    const uploadResponse = await axios.post(uploadUrl, formData, {
      headers: { 
        'Authorization': `Bearer ${destSession.token}`,
        ...formData.getHeaders()
      }
    });
    
    fs.unlinkSync(tempFilePath);
    console.log(`Archivo temporal eliminado: ${tempFilePath}`);
    
    if (!uploadResponse.data || !uploadResponse.data[0] || !uploadResponse.data[0].id) {
      console.error('Respuesta de subida inválida:', uploadResponse.data);
      throw new Error('No se recibió respuesta válida al subir la imagen');
    }
    
    const newImage = uploadResponse.data[0];
    console.log(`Imagen subida exitosamente. Nuevo ID: ${newImage.id}, URL: ${newImage.url}`);
    
    return newImage;
    
  } catch (error) {
    console.error(`Error en uploadImage: ${error.message}`);
    if (error.response) {
      console.error('Respuesta de error:', JSON.stringify({
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      }, null, 2));
    }
    return null;
  }
}

async function syncComponentAdmin(sourceSession, destSession, contentId, component) {
  const collectionUID = component.contentType;
  const getDevUrl = `${sourceSession.baseUrl}/content-manager/collection-types/${collectionUID}/${contentId}?populate=*&plugins[i18n][locale]=en`;
  
  console.log(`Obteniendo datos de origen (Dev) para componente: GET -> ${getDevUrl}`);
  
  const devRes = await axios.get(getDevUrl, {
    headers: { Authorization: `Bearer ${sourceSession.token}` }
  });
  const devData = devRes.data;
  if (!devData || !devData.id) {
    throw new Error('No se encontró la página fuente para extraer componente.');
  }

  console.log(`Datos de origen (Dev) para "${devData.name || 'página'}":`, JSON.stringify({
    id: devData.id,
    name: devData.name,
    uri: devData.uri
  }, null, 2));

  const compInfo = extractComponent(devData, component.id);
  if (!compInfo) {
    throw new Error(`No se encontró el componente: ${component.id} en la fuente`);
  }

  let existingPage = null;
  
  if (devData.uri) {
    try {
      console.log(`Buscando en Prod páginas con URI: "${devData.uri}"`);
      const searchQuery = `filters[uri][$eq]=${encodeURIComponent(devData.uri)}`;
      const findUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?${searchQuery}`;
      console.log(`Búsqueda por URI: GET -> ${findUrl}`);
      
      const findRes = await axios.get(findUrl, {
        headers: { Authorization: `Bearer ${destSession.token}` }
      });
      
      console.log('Resultado de búsqueda:', JSON.stringify({
        status: findRes.status,
        resultCount: findRes.data.results ? findRes.data.results.length : 0
      }, null, 2));
      
      const existingPages = findRes.data.results;
      if (existingPages && existingPages.length > 0) {
        existingPage = existingPages[0];
        console.log(`Encontrada página existente en Prod con URI="${devData.uri}", ID=${existingPage.id}, Nombre="${existingPage.name}"`);
      } else {
        console.log(`No se encontró página con URI="${devData.uri}" en Prod.`);
      }
    } catch (err) {
      console.log('Error buscando página existente:', err.message);
    }
  } else {
    console.log('La página de origen no tiene URI, se creará como nueva.');
  }
  
  const cleanedComponent = deepCleanData(compInfo.value);
  
  if (compInfo.value) {
    await processNestedImages(cleanedComponent, sourceSession, destSession);
  }
  
  let directPayload;
  if (compInfo.fullArray) {
    const updatedArray = [...compInfo.fullArray];
    updatedArray[compInfo.index] = cleanedComponent;
    directPayload = { [compInfo.key]: updatedArray };
  } else {
    directPayload = { [compInfo.key]: cleanedComponent };
  }
  
  const wrappedPayload = { data: directPayload };
  
  const putUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}/${existingPage.id}?plugins[i18n][locale]=en`;
  console.log(`Actualizando componente en página existente: PUT -> ${putUrl}`);
  
  try {
    console.log("Intentando formato #1 para componente...");
    const putRes = await axios.put(putUrl, directPayload, {
      headers: { 
        'Authorization': `Bearer ${destSession.token}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Actualización de componente exitosa (formato #1)');
    return putRes.data;
  } catch (error) {
    console.error('Error en formato #1 para componente:', error.message);
    if (error.response) {
      console.error('Detalles del error:', JSON.stringify({
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      }, null, 2));
    }
    
    try {
      console.log("Intentando formato #2 para componente...");
      const putRes = await axios.put(putUrl, wrappedPayload, {
        headers: { 
          'Authorization': `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Actualización de componente exitosa (formato #2)');
      return putRes.data;
    } catch (error2) {
      console.error('Error en formato #2 para componente:', error2.message);
      if (error2.response) {
        console.error('Detalles del error:', JSON.stringify({
          status: error2.response.status,
          statusText: error2.response.statusText,
          data: error2.response.data
        }, null, 2));
      }
      throw new Error('No se pudo actualizar el componente en ningún formato');
    }
  }
}


function extractComponent(obj, compId) {
  const splitted = compId.split('_');
  const key = splitted[1];
  const idx = splitted[2] ? parseInt(splitted[2], 10) : null;
  const val = obj[key];
  if (!val) return null;
  if (Array.isArray(val) && idx !== null) {
    return { key, index: idx, value: val[idx], fullArray: val };
  } else if (!Array.isArray(val) && typeof val === 'object') {
    return { key, value: val };
  }
  return null;
}

app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
  console.log(`Abre http://localhost:${PORT} para usar la interfaz.`);
});
