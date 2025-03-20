const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

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
    // https://strapi.dev/admin/content-manager/collectionType/api::page.page/1340?plugins[i18n][locale]=en
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

    if (systemFields.includes(key) && !(obj.mime && obj.mime.startsWith('image/'))) {
      continue;
    }

    const val = obj[key];
    if (val && typeof val === 'object') {
      cleanedObj[key] = deepCleanData(val);
    } else {
      cleanedObj[key] = val;
    }
  }

  return cleanedObj;
}

function removeImageFields(data) {
  if (!data || typeof data !== 'object') return data;
  
  if (data.metadata && data.metadata.ogImage) {
    delete data.metadata.ogImage;
  }
  
  if (data.hero) {
    delete data.hero;
  }
  
  if (data.content && Array.isArray(data.content)) {
    data.content = data.content.map(item => {
      if (item.media) {
        delete item.media;
      }
      return item;
    });
  }
  
  return data;
}


async function copyRelationsFor(devRelation, collectionUID, destSession) {
  if (!devRelation || !devRelation.data || !devRelation.data.length) {
    return null;
  }

  const newRelationArray = [];

  for (const item of devRelation.data) {
    const name = item.name || (item.attributes && item.attributes.name);
    const code = item.code || (item.attributes && item.attributes.code);

    if (!name && !code) {
      console.log('No se encontró ni name ni code en la relación. Se omite:', item);
      continue;
    }

    const entityId = await findOrCreateEntity(destSession, collectionUID, name, code);
    if (entityId) {
      newRelationArray.push({ id: entityId });
    }
  }

  if (!newRelationArray.length) {
    return null;
  }

  return { data: newRelationArray };
}

async function findOrCreateEntity(destSession, collectionUID, name, code) {
  let filterQuery = '';
  if (code) {
    filterQuery = `filters[code][$eq]=${encodeURIComponent(code)}`;
  } else {
    filterQuery = `filters[name][$eq]=${encodeURIComponent(name)}`;
  }

  const findUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?${filterQuery}`;
  console.log(`Buscando en prod: GET -> ${findUrl}`);

  try {
    const findRes = await axios.get(findUrl, {
      headers: { Authorization: `Bearer ${destSession.token}` }
    });

    const found = findRes.data.results;
    if (found && found.length > 0) {
      const foundId = found[0].id;
      console.log(`Encontrado en prod: ID=${foundId} (name=${name}, code=${code || 'N/A'})`);
      return foundId;
    }
  } catch (err) {
    console.error(`Error buscando ${collectionUID}:`, err.message);
  }

  return await createEntity(destSession, collectionUID, name, code);
}

async function createEntity(destSession, collectionUID, name, code) {
  console.log(`Creando nueva entidad en ${collectionUID}: (name=${name}, code=${code || 'N/A'})`);

  const dataPayload = { name };
  if (code) dataPayload.code = code;

  const directPayload = dataPayload;
  const wrappedPayload = { data: dataPayload };

  const postUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}`;
  try {
    console.log("Intentando crear (formato #1)...");
    const postRes = await axios.post(postUrl, directPayload, {
      headers: {
        'Authorization': `Bearer ${destSession.token}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Creado exitosamente (formato #1):', postRes.data.id);
    return postRes.data.id;
  } catch (error) {
    console.error('Error creando (formato #1):', error.message);
    try {
      console.log("Intentando crear (formato #2)...");
      const postRes = await axios.post(postUrl, wrappedPayload, {
        headers: {
          'Authorization': `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Creado exitosamente (formato #2):', postRes.data.id);
      return postRes.data.id;
    } catch (error2) {
      console.error('Error creando (formato #2):', error2.message);
      throw new Error('No se pudo crear la entidad en ningún formato');
    }
  }
}

async function syncFullPageAdmin(sourceSession, destSession, contentId, item) {
  const collectionUID = item.contentType;

const getDevUrl = `${sourceSession.baseUrl}/content-manager/collection-types/${collectionUID}/${contentId}
?populate[site][populate]=*
&populate[sliders][populate]=*
&populate[features][populate]=*
&populate[resorts][populate]=*
&populate[hero]=*
&populate[seo][populate]=*
&populate[publisher][populate]=*
&plugins[i18n][locale]=en`
.replace(/\s+/g, '');


  console.log(`Obteniendo datos de origen (Dev): GET -> ${getDevUrl}`);

  const devRes = await axios.get(getDevUrl, {
    headers: { Authorization: `Bearer ${sourceSession.token}` }
  });
  const devData = devRes.data;
  if (!devData || !devData.id) {
    throw new Error('No se encontró la página en la fuente (Dev).');
  }

  console.log(`Datos de origen (Dev) para "${devData.name || 'página'}":`, {
    id: devData.id,
    name: devData.name,
    uri: devData.uri
  });

  let existingPage = null;
  if (devData.uri) {
    try {
      const searchQuery = `filters[uri][$eq]=${encodeURIComponent(devData.uri)}`;
      const findUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?${searchQuery}`;
      console.log(`Buscando en Prod por URI: GET -> ${findUrl}`);

      const findRes = await axios.get(findUrl, {
        headers: { Authorization: `Bearer ${destSession.token}` }
      });
      const existingPages = findRes.data.results;
      if (existingPages && existingPages.length > 0) {
        existingPage = existingPages[0];
        console.log(`Página existente en Prod con URI="${devData.uri}", ID=${existingPage.id}`);
      } else {
        console.log(`No se encontró página con URI="${devData.uri}" en Prod.`);
      }
    } catch (err) {
      console.log('Error buscando página existente en Prod:', err.message);
    }
  }

  let cleanedData = deepCleanData(devData);
  cleanedData = removeImageFields(cleanedData);

  cleanedData.name = devData.name;
  cleanedData.uri = devData.uri;
  cleanedData.locale = 'en';
  cleanedData.publishedAt = new Date().toISOString();


  console.log("Procesando relaciones...");
  try {
    if (devData.site && devData.site.data) {
      console.log("Procesando relación de site...");
      cleanedData.site = await copyRelationsFor(devData.site, 'api::site.site', destSession);
      console.log("Relación de site procesada:", cleanedData.site);
    }
  } catch (error) {
    console.error("Error procesando relación de site:", error.message);
  }
  
  try {
    if (devData.sliders && devData.sliders.data && devData.sliders.data.length) {
      console.log("Procesando relación de sliders...");
      cleanedData.sliders = await copyRelationsFor(devData.sliders, 'api::slider.slider', destSession);
      console.log("Relación de sliders procesada:", cleanedData.sliders);
    }
  } catch (error) {
    console.error("Error procesando relación de sliders:", error.message);
  }
  
  try {
    if (devData.features && devData.features.data && devData.features.data.length) {
      console.log("Procesando relación de features...");
      cleanedData.features = await copyRelationsFor(devData.features, 'api::feature.feature', destSession);
      console.log("Relación de features procesada:", cleanedData.features);
    }
  } catch (error) {
    console.error("Error procesando relación de features:", error.message);
  }
  
  try {
    if (devData.resorts && devData.resorts.data && devData.resorts.data.length) {
      console.log("Procesando relación de resorts...");
      cleanedData.resorts = await copyRelationsFor(devData.resorts, 'api::resort.resort', destSession);
      console.log("Relación de resorts procesada:", cleanedData.resorts);
    }
  } catch (error) {
    console.error("Error procesando relación de resorts:", error.message);
  }

  try {
    if (devData.seo && devData.seo.data && devData.seo.data.length) {
      console.log("Procesando relación de seo...");
      cleanedData.seo = await copyRelationsFor(devData.seo, 'api::seo.seo', destSession);
      console.log("Relación de seo procesada:", cleanedData.seo);
    }
  } catch (error) {
    console.error("Error procesando relación de seo:", error.message);
  }

  try {
    if (devData.publisher && devData.publisher.data && devData.publisher.data.length) {
      console.log("Procesando relación de publisher...");
      cleanedData.publisher = await copyRelationsFor(devData.publisher, 'api::publisher.publisher', destSession);
      console.log("Relación de publisher procesada:", cleanedData.publisher);
    }
  } catch (error) {
    console.error("Error procesando relación de publisher:", error.message);
  }

  const directPayload = cleanedData;
  const wrappedPayload = { data: cleanedData };

  if (existingPage) {
    const putUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}/${existingPage.id}?plugins[i18n][locale]=en`;
    console.log(`Actualizando página en Prod: PUT -> ${putUrl}`);

    try {
      const putRes = await axios.put(putUrl, directPayload, {
        headers: {
          Authorization: `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Página actualizada (formato #1):', putRes.data.id);
      return putRes.data;
    } catch (error) {
      console.error('Error actualizando (formato #1):', error.message);
      try {
        const putRes2 = await axios.put(putUrl, wrappedPayload, {
          headers: {
            Authorization: `Bearer ${destSession.token}`,
            'Content-Type': 'application/json'
          }
        });
        console.log('Página actualizada (formato #2):', putRes2.data.id);
        return putRes2.data;
      } catch (error2) {
        console.error('Error actualizando (formato #2):', error2.message);
        throw new Error('No se pudo actualizar la página en ningún formato');
      }
    }
  } else {
    const postUrl = `${destSession.baseUrl}/content-manager/collection-types/${collectionUID}?plugins[i18n][locale]=en`;
    console.log(`Creando página en Prod: POST -> ${postUrl}`);

    try {
      const postRes = await axios.post(postUrl, directPayload, {
        headers: {
          Authorization: `Bearer ${destSession.token}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Página creada (formato #1):', postRes.data.id);
      return postRes.data;
    } catch (error) {
      console.error('Error creando (formato #1):', error.message);
      try {
        const postRes2 = await axios.post(postUrl, wrappedPayload, {
          headers: {
            Authorization: `Bearer ${destSession.token}`,
            'Content-Type': 'application/json'
          }
        });
        console.log('Página creada (formato #2):', postRes2.data.id);
        return postRes2.data;
      } catch (error2) {
        console.error('Error creando (formato #2):', error2.message);
        throw new Error('No se pudo crear la página en ningún formato');
      }
    }
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

  console.log(`Datos de origen (Dev) para "${devData.name || 'página'}":`, {
    id: devData.id,
    name: devData.name,
    uri: devData.uri
  });

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

      console.log('Resultado de búsqueda:', {
        status: findRes.status,
        resultCount: findRes.data.results ? findRes.data.results.length : 0
      });

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

  let cleanedComponent = deepCleanData(compInfo.value);
  cleanedComponent = removeImageFields(cleanedComponent);

  let directPayload;
  if (compInfo.fullArray) {
    const updatedArray = [...compInfo.fullArray];
    updatedArray[compInfo.index] = cleanedComponent;
    directPayload = { [compInfo.key]: updatedArray };
  } else {
    directPayload = { [compInfo.key]: cleanedComponent };
  }
  const wrappedPayload = { data: directPayload };

  if (!existingPage) {
    throw new Error('No existe la página en prod para poder actualizar el componente.');
  }

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
