import Middleware from './middleware'

/**
 * Automatic batching of requests.
 *
 * TODO
 */
export default class Batch extends Middleware {

  constructor( ...args ) {
    super( ...args )
    this.batchUrl = null
    this.batch = []
    this.timeout = 100 // ms
    this._to = null
  }

  process = request => {
    let b = { request }

    // Note that the promise function argument runs synchronously
    // in order to explicitly support this use-case.
    let promise = new Promise( ( resolve, reject ) => {
      b.resolve = resolve
      b.reject = reject
    })
    this.batch.push( b )

    // The first request to come in sets the timer, and we don't
    // reset the timer on any subsequent requests; it will just
    // catch anything that comes in within the timeout.
    if( !this._to ) {
      this._to = setTimeout( this.submitBatch, this.timeout )
    }

    return promise
  }

  submitBatch = () => {
    // TODO: Any chance of concurrency issues?
    let batch = this.batch
    this.batch = []
    this._to = null

    let request = this.combineRequests( batch )
    this.submit( request )
        .then( r => this.splitResponses( batch, r ) )
  }

  combineRequests = batch => {
    return {
      url: this.batchUrl,
      method: 'post',
      body: batch.map( b => this.transformRequest( b.request ) ),
    }
  }

  transformRequest = request => {
    return {
      method: request.method,
      body: request.body,
      headers: request.headers,
    }
  }

  splitResponses = ( batch, responses ) => {
    for( let ii = 0; ii < batch.length; ++ii ) {
      let r = responses[ii]

      // Currently use the presence of "status_code" to know that
      // something has gone wrong.
      if( r.status_code !== undefined ) {
        batch[ii].reject( r.body )
      }
      else {
        batch[ii].resolve( r.body )
      }
    }
  }
}
