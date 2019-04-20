import { jsonApiQuery } from './jsonapi'
import {
  ajax,
  ajaxWithRequest,
  contentTypes,
  postJson,
  postForm,
  ajaxSettings,
  supplant,
  addTrailingSlash,
  matchContentType,
  makeFormData,
  makeRequest,
  takeFirst
} from './utils'
import { ApiError } from './errors'
import Middleware from './middleware'
import Batch from './batch'

/**
 * Describes an API.
 */
export default class Api {

  /**
   * Constructs an Api instance. Accepts an endpoint tree.
   */
  constructor( endpoints = {} ) {
    this.crud = {}
    this.middlewares = []
    this.merge( endpoints )
    this.urlRoot = null
    this.defaultType = null
  }

  pushMiddleware = middleware => {
    if ( !Array.isArray( middleware ) ) {
      middleware = [middleware]
    }
    middleware.forEach( m => {
      m.api = this
      this.middlewares.push( m )
      m.contributeToApi(this)
    })
  }

  unshiftMiddleware = middleware => {
    if( !Array.isArray( middleware ) ) {
      middleware = [middleware]
    }
    middleware.forEach( m => {
      m.api = this
      this.middlewares.unshift( m )
    })
  }

  /**
   * Merge an endpoint tree.
   */
  merge = ( endpoints, path = '' ) => {
    if( !endpoints ) {
      throw new Error( 'Empty endpoint data given to Api.merge.' )
    }

    for( const key of Object.keys( endpoints ) ) {
      let ep = endpoints[key]

      // Check if we're looking at an endpoint.
      let match = /^(GET|POST|PUT|PATCH|DELETE|CRUD)$/.exec( key )
      if( match ) {

        // If we matched a CRUD endpoint, perform the setup.
        if( match[1] == 'CRUD' ) {
          const ii = path.lastIndexOf( '/' ) + 1
          let crudKey = path.slice( ii )
          let crudPath = path.slice( 0, ii )
          this.makeCrudEndpoints( crudKey, crudPath )
        }

        // The endpoint can be just the name of the function
        // or it can be an object of details.
        else {
          if( !(ep instanceof Object) ) {
            ep = { name: ep }
          }
          const { name, options = {} } = ep

          // Make the endpoint.
          this.makeEndpoint( name, path + '/', match[1], options )
        }
      }

      // If not an endpoint, check for a CRUD shorthand.
      else if( ep == 'CRUD' ) {
        this.makeCrudEndpoints( key, path )
      }

      // If not an endpoint or CRUD, continue down the tree.
      else {
        this.merge( ep, path + '/' + key )
      }
    }
  }

  /**
   * Constructs an endpoint call function and sets it on the object.
   *
   * @param {string} name - The name of the endpoint function.
   * @param {string} path - The URL path to use.
   * @param {string} method - The method to use for this call.
   * @param {func} handler - A custom handler to call.
   */
  makeEndpoint = ( name, path, method, opts = {} ) => {

    // Fail loudly if we're overriding names.
    if( this[name] !== undefined ) {
      throw new Error( `Duplicate name in Api: ${name}` )
    }

    // Prepare the context to be passed to the request method. This
    // will be passed to the each invocation of the endpoint call
    // as a set of defaults.
    let ctx = {
      ...opts,
      path: addTrailingSlash( path ),
      method
    }

    // If we were given a function to call, bind it appropriately.
    // Otherwise just use the standard request.
    let request = (opts) => this.request(ctx, opts)

    const { handler } = opts
    if( handler !== undefined ) {

      // The first argument to the handler will be a function to call
      // the builtin handler. This allows the handler to easily finalise
      // the call after modifying any options.
      let wrapper = function(...args) {
        return handler(request, ...args)
      }
      wrapper.context = ctx
      this[name] = wrapper
    }
    else {
      request.context = ctx
      this[name] = request
    }

    return this[name]
  }

  /**
   * Automatically create a set of CRUD endpoint functions.
   */
  makeCrudEndpoints = ( key, path ) => {
    const joiner = ((path[path.length - 1] == '/') ? '' : '/')
    const basePath = path + joiner + key
    this.crud[key] = {
      list: this.makeEndpoint( key + 'List', basePath, 'GET' ),
      create: this.makeEndpoint( key + 'Create', basePath, 'POST', {
        handler: (req, payload, opts = {}) => req({
          ...opts,
          payload
        })
      }),
      detail: this.makeEndpoint( key + 'Get', basePath + '/{id}', 'GET', {
        handler: (req, id, opts = {}) => {
          return req({
            ...opts,
            params: {id}
          })
        }
      }),
      update: this.makeEndpoint( key + 'Update', basePath + '/{id}', 'PATCH', {
        handler: (req, id, payload, opts = {}) => {
          return req({
            ...opts,
            params: {id},
            payload
          })
        }
      }),
      remove: this.makeEndpoint( key + 'Remove', basePath + '/{id}', 'DELETE', {
        handler: (req, id, opts = {}) => req({
          ...opts,
          params: {id}
        })
      }),
      options: this.makeEndpoint(key + 'Options', basePath, 'OPTIONS'),
    }
  }

  /**
   * Perform a request call.
   */
  request = (endpoint, options = {}) => {
    const {
      method = (endpoint.method || '').toLowerCase(),
      path = endpoint.path,
      params = {},
      payload,
      type = endpoint.type || this.defaultType,
      extraHeaders = {},
      include = (endpoint.include || []),
      filter = (endpoint.filter || {}),
      sort = (endpoint.sort || []),
      fields = (endpoint.fields || []),
      rawFilters,
      ...otherOptions
    } = options
    let {
      urlRoot = this.urlRoot,
      contentType = endpoint.contentType
    } = options

    // "type" is used a convenient shorthand for the content type.
    // "contentType" still trumps it.
    if( !!type && !contentType ) {
      contentType = contentTypes[type]
    }

    // Process the body. This can end up being a FormData object
    // or a json string.
    let body
    let queryString = []
    if( method != 'get' && method != 'options' ) {
      if( payload !== undefined ) {
        if( matchContentType( contentType, 'form' ) || matchContentType( contentType, 'multiForm' ) ) {
          body = makeFormData( payload )
        }
        else {
          body = JSON.stringify( (payload || {}) )
        }
      }
    }
    else {
      if( payload !== undefined ) {
        for( const k in payload ) {
          queryString.push( k + '=' + encodeURIComponent( payload[k] ) )
        }
      }
    }

    // Replace any URL arguments. This is typically just the ID of
    // an object.
    let finalPath = supplant( path, params )

    // Add any JSONAPI query strings.
    finalPath += jsonApiQuery({
      initial: queryString,
      include,
      filter,
      sort,
      fields,
      rawFilters: takeFirst(rawFilters, this.rawFilters, endpoint.rawFilters)
    })

    // If we've been given an URL root, add it in here. This is useful
    // for writing Node tests.
    if( urlRoot ) {
      if( urlRoot[urlRoot.length - 1] == '/' ) {
        urlRoot = urlRoot.substring( 0, urlRoot.length - 1 )
      }
      finalPath = urlRoot + finalPath
    }

    // Prepare the request object. This is passed to either "ajax"
    // or the middlewares.
    let req = {
      url: finalPath,
      method,
      body,
      contentType,
      extraHeaders,
      bearer: this.bearer
    }

    // If there are no middlewares, we are free to fulfill the request
    // now.
    let obj
    if( !this.middlewares.length ) {
      console.debug( `API ${method} ${type}: ${finalPath}`, payload )
      obj = ajax( req )
    }

    // Otherwise, we need to pipe through all the middleware. This works
    // by iterating over middleware in order until one returns a promise.
    // We then chain the remaining middleware after that promise. It's the
    // user's responsibility to ensure only one middleware wants to return
    // a promise.
    else {
      req = makeRequest(req)

      // Run all preprocess middlewares.
      for (const mw of this.middlewares) {
        req = mw.preProcess(this, req, otherOptions)
      }

      // Run the old version 1 middleware stack.
      let ii = 0
      obj = this.middlewares[ii++].process(this, req, otherOptions)
      for( ; ii < this.middlewares.length; ++ii ) {
        if( Promise.resolve( obj ) == obj ) {
          for( ; ii < this.middlewares.length; ++ii ) {
            let mw = this.middlewares[ii]
            obj = obj.then( r => mw.process( this, r, otherOptions ) )
          }
        }
        else {
          obj = this.middlewares[ii].process( this, obj, otherOptions )
        }
      }

      // If we didn't end up with a promise then send the request.
      if (Promise.resolve(obj) != obj) {
        obj = ajaxWithRequest(obj)
      }

      // Run postprocess middlewares.
      for (const mw of this.middlewares.reverse()) {
        obj = obj.then(r => mw.postProcess(this, r, otherOptions))
      }
    }

    // Return response.  Breaking change between version 0.2.6 and later versions, as this
    // function has previously been returning response.data
    return obj
  }
}

export {
  ajax,
  postJson,
  postForm,
  ajaxSettings,
  ApiError,
  Middleware,
  Batch
}
