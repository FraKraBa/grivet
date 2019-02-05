import { Spec } from './jsonapiSpec';
import { SchemaError } from './schemaChecker';
import { memoized } from './memoized.decorator';

export { Spec };

/**
 * This is the main module of Grivet. It contains the [[Document]], [[Resource]] and [[Relationship]] classes that
 * perform most of the work interpreting a JSON:API structure.
 */
export namespace JsonApi {
  /** Thrown when there is mismatch between the expected resource count (one or many) and the actual resource count */
  export class CardinalityError extends Error {}
  /** Thrown when an explicitly provided id does not match the id received from the server */
  export class IdMismatchError extends Error {}

  /**
   * Implement this interface to define how a [[JsonApiDocument]] (the JSON:API raw data) is fetched from `related` links,
   * e.g. from a remote server via HTTP.
   *
   * [[include:guides/context.md]]
   */
  export interface Context {
    /**
     * Should return a `Promise` resolving to the JSON:API document for the given `url`
     */
    getDocument(url: URL): Promise<Spec.JsonApiDocument>;
  }

  /** List of fields that should be fetched from the server */
  export type FieldNames = string[];
  /** Mapping from resource type to sparse fields */
  export type SparseFields = { [resourceType: string]: FieldNames };

  /**
   * Holds an `application/vnd.api+json` [document](https://jsonapi.org/format/1.0/#document-top-level) and
   * provides methods to access the resources in that document.
   * This is the main class that acts as an entry point to traverse to other resources.
   * Use the static [[fromURL]] method to fetch and construct a [[Document]] from a given URL.
   */
  export class Document {
    /**
     * Fetch data from the given URL and construct a [[Document]] from it.
     * If `sparseFields` are given, only those fields are requested from the server.
     */
    static async fromURL(url: URL, context: Context, sparseFields?: SparseFields): Promise<Document> {
      for (const resourceType in sparseFields) {
        url.searchParams.append(`fields[${resourceType}]`, sparseFields[resourceType].join(','));
      }
      const rawData = await context.getDocument(url);
      return new Document(rawData, context, url, sparseFields);
    }

    /**
     * Directly construct a [[Document]] from raw JSON:API data. Does not fetch any data from a server.
     * An optional URL can be provided to indicate where the raw data came from.
     * @throws [[SchemaError]] when the given rawData does not look like a JSON:API document
     */
    constructor(
      readonly rawData: Spec.JsonApiDocument,
      private readonly context: Context,
      public readonly url?: URL,
      public readonly sparseFields?: SparseFields
    ) {
      Spec.checkDocumentSchema(rawData);
    }

    /**
     * `true` if this document's primary data is an array of resources and not just a single resource
     */
    @memoized()
    get hasManyResources(): boolean {
      return Array.isArray(this.rawData.data);
    }

    /**
     * List of the main (primary) [[Resource]]s in this document.
     * @throws [[CardinalityError]] if the document instead only contains a singular resource.
     */
    @memoized()
    get resources(): PrimaryResource[] {
      if (!this.hasManyResources) {
        throw new CardinalityError(
          'Document does not contain an array of resources. Use the `resource` property instead'
        );
      }
      return (<Spec.ResourceObject[]>this.rawData.data).map(
        primaryData => new PrimaryResource(primaryData, this, primaryData.type, this.context)
      );
    }

    /**
     * The main (primary) [[Resource]] in this document.
     * @throws [[CardinalityError]] if the document instead contains an array of resources.
     */
    @memoized()
    get resource(): PrimaryResource | null {
      if (this.hasManyResources) {
        throw new CardinalityError('Document contains an array of resources. Use the `resources` property instead');
      }
      if (this.rawData.data === null) {
        return null;
      }
      const primaryData = <Spec.ResourceObject>this.rawData.data;
      return new PrimaryResource(primaryData, this, primaryData.type, this.context);
    }

    /**
     * Map from type and id to [[Resource]] for all resources under the top level `included` member
     */
    @memoized()
    get includedResources(): IncludedResourcesMap {
      const res: IncludedResourcesMap = {};
      // tslint:disable-next-line:strict-boolean-expressions
      for (const includedResource of this.rawData.included || []) {
        if (!(includedResource.type in res)) {
          res[includedResource.type] = {};
        }
        res[includedResource.type][includedResource.id] = new RelatedResource(
          this,
          includedResource.id,
          includedResource.type,
          this.context
        );
      }
      return res;
    }
  }

  /** Collection of [[RelatedResource]]s included in a compound document, organized by type and id */
  export type IncludedResourcesMap = { [type: string]: { [id: string]: RelatedResource } };
  /** Mapping from relationship name to [[Relationship]] */
  export type Relationships = { [relationshipName: string]: Relationship };
  /** Mapping from link name to [[Link]] */
  export type Links = { [linkName: string]: Link };

  /** @hidden */
  type RelationshipToResource = { [relationshipName: string]: Resource };
  /** @hidden */
  type RelationshipToResources = { [relationshipName: string]: Resource[] };
  /** @hidden */
  type RelationshipToDocument = { [relationshipName: string]: Document };

  /** @hidden */
  class RelatedResourceAccessor<T extends RelationshipToResource> implements ProxyHandler<T> {
    constructor(private readonly parent: Resource) {}
    /**
     * Provide access to parent related resource
     * @hidden
     */
    async get(target: T, relationshipName: string, receiver: any): Promise<Resource | null | undefined> {
      if (relationshipName in this.parent.relationships) {
        return this.parent.relationships[relationshipName].resource();
      }
    }
  }

  /** @hidden */
  class RelatedResourcesAccessor<T extends RelationshipToResources> implements ProxyHandler<T> {
    constructor(private readonly parent: Resource) {}
    /**
     * Provide access to parent related resources
     * @hidden
     */
    async get(target: T, relationshipName: string, receiver: any): Promise<Resource[]> {
      if (relationshipName in this.parent.relationships) {
        return this.parent.relationships[relationshipName].resources();
      }
      return [];
    }
  }

  /** @hidden */
  class RelatedDocumentAccessor<T extends RelationshipToDocument> implements ProxyHandler<T> {
    constructor(private readonly parent: Resource) {}
    /**
     * Provide access to parent related document
     * @hidden
     */
    async get(target: T, relationshipName: string, receiver: any): Promise<Document | undefined> {
      if (relationshipName in this.parent.relationships) {
        return this.parent.relationships[relationshipName].relatedDocument();
      }
    }
  }

  /**
   * Represents a JSON:API resource object
   * @see https://jsonapi.org/format/#document-resource-objects
   */
  export abstract class Resource {
    constructor(
      protected readonly document: Document,
      public readonly id: string,
      public readonly type: string,
      private readonly context: Context
    ) {}

    protected abstract getData(): Spec.ResourceObject;

    /** The raw JSON:API data of this resource */
    @memoized()
    get rawData(): Spec.ResourceObject {
      return this.getData();
    }

    /**
     * Object containing all [attributes](https://jsonapi.org/format/1.0/#document-resource-object-attributes) of this resource
     */
    get attributes(): Spec.AttributesObject | undefined {
      return this.rawData.attributes;
    }

    /**
     * Map containing all [[Relationship]]s defined by this resource
     */
    @memoized()
    get relationships(): Relationships {
      if (!this.rawData.relationships) {
        return {};
      }
      const result: Relationships = {};
      for (const relationshipName in this.rawData.relationships) {
        result[relationshipName] = new Relationship(
          this.document,
          this.rawData.relationships[relationshipName],
          this.context
        );
      }
      return result;
    }

    /**
     * Map containing all [[Link]]s defined by this resource
     */
    @memoized()
    get links(): Links {
      if (!this.rawData.links) {
        return {};
      }
      const result: Links = {};
      for (const linkName in this.rawData.links) {
        result[linkName] = new Link(this.rawData.links[linkName]);
      }
      return result;
    }

    /**
     * Map containing all entries inside `links` of `meta` interpreted as JSON:API Link (either string or link object)
     */
    @memoized()
    get metaLinks(): Links {
      if (!this.rawData.meta) {
        return {};
      }
      if (!this.rawData.meta.links) {
        return {};
      }
      const result: Links = {};
      for (const linkName in this.rawData.meta.links) {
        result[linkName] = new Link(this.rawData.meta.links[linkName]);
      }
      return result;
    }

    /**
     * Object containing all [meta data](https://jsonapi.org/format/1.0/#document-meta) of this resource
     */
    @memoized()
    get meta(): Spec.MetaObject | undefined {
      return this.rawData.meta;
    }

    /**
     * Self-link defined in the `links` member
     */
    get selfLink(): Link | undefined {
      return this.links['self'];
    }

    /**
     * Map containing all multiple [[Resource]]s reachable via relationships from this resource.
     */
    get relatedResources() {
      return new Proxy(<RelationshipToResources>{}, new RelatedResourcesAccessor(this));
    }

    /**
     * Map containing all singular [[Resource]]s reachable via relationships from this resource.
     */
    get relatedResource() {
      return new Proxy(<RelationshipToResource>{}, new RelatedResourceAccessor(this));
    }

    /**
     * Map containing all [[Document]]s reachable via relationships from this resource.
     */
    get relatedDocuments() {
      return new Proxy(<RelationshipToDocument>{}, new RelatedDocumentAccessor(this));
    }
  }

  /**
   * A resource contained in the top level `data` member of the [[Document]].
   *
   * Always constructed non-lazily from the parent [[Document]].
   *
   * @throws [[IdMismatchError]] when the optional `id` argument does not match the id present in `rawData`
   * @throws [[SchemaError]] when `rawData` does not look like a JSON:API resource object
   */
  export class PrimaryResource extends Resource {
    private readonly pRawData: Spec.ResourceObject;

    constructor(rawData: Spec.ResourceObject, document: Document, resourceType: string, context: Context, id?: string) {
      Spec.checkResourceObjectSchema(rawData);
      const passedId = id;
      id = rawData.id;
      if (passedId !== undefined && id !== passedId) {
        throw new IdMismatchError(`ID in rawData does not match given ID: ${id} != ${passedId}`);
      }
      super(document, id, resourceType, context);
      this.pRawData = rawData;
    }

    protected getData(): Spec.ResourceObject {
      return this.pRawData;
    }
  }

  /**
   * A resource contained in the top level `included` member of the [[Document]] or linked via href.
   *
   * Is initialized on demand via the `getData` method.
   *
   * @throws [[IdMismatchError]] when `id` was not found in the given `document`
   */
  export class RelatedResource extends Resource {
    constructor(document: Document, id: string, resourceType: string, context: Context) {
      super(document, id, resourceType, context);
    }

    /**
     * Find the matching resource in the parent [[Document]]
     * @throws [[IdMismatchError]] if the resource is not found or found multiple times
     * @throws [[SchemaError]] when `rawData` does not look like a JSON:API resource object
     */
    protected getData(): Spec.ResourceObject {
      const primaryDataArray = this.document.hasManyResources
        ? <Spec.ResourceObject[]>this.document.rawData.data
        : [<Spec.ResourceObject>this.document.rawData.data];
      // tslint:disable-next-line:strict-boolean-expressions
      const candidates = primaryDataArray.concat(this.document.rawData.included || []);
      const filtered = candidates.filter(
        resourceObject => resourceObject.type === this.type && resourceObject.id === this.id
      );
      if (filtered.length === 0) {
        throw new IdMismatchError(`Resource with id "${this.id}" and type "${this.type}" not found in document`);
      }
      if (filtered.length > 1) {
        throw new IdMismatchError(
          `Resource with id "${this.id}" and type "${this.type}" found more than once in document`
        );
      }
      Spec.checkResourceObjectSchema(filtered[0]);
      return filtered[0];
    }
  }

  /**
   * Represents a link with URL and optional meta data
   */
  export class Link {
    /** The complete url for this link */
    url: URL;
    /** Any additional meta data */
    meta?: object;

    constructor(rawData: Spec.Link, referringDocumentURL?: URL) {
      const origin = referringDocumentURL ? referringDocumentURL.origin : '';
      if (typeof rawData === 'string') {
        try {
          this.url = new URL(rawData);
        } catch (e) {
          this.url = new URL(origin + rawData);
        }
      } else {
        try {
          this.url = new URL(rawData.href);
        } catch (e) {
          this.url = new URL(origin + rawData.href);
        }
        this.meta = rawData.meta;
      }
    }
  }

  /**
   * Defines relations to [[Resource]]s (included in the document or external) and can resolve them.
   * @throws [[SchemaError]] when `rawData` does not look like a JSON:API relationship object
   */
  export class Relationship {
    constructor(
      private readonly referringDocument: Document,
      private readonly rawData: Spec.RelationshipObject,
      private readonly context: Context
    ) {
      Spec.checkRelationshipObjectSchema(rawData);
    }

    /** `true` if the relationship only contains a `meta` member and no `data` or `links` */
    @memoized()
    get empty(): boolean {
      return this.links === undefined && this.data === undefined;
    }

    /**
     * Map of link names to [[Link]]s defined under the `links` member of this relationship
     */
    @memoized()
    get links(): Links | undefined {
      if (!this.rawData.links) {
        return undefined;
      }
      const result: Links = {};
      for (const linkName in this.rawData.links) {
        result[linkName] = new Link(this.rawData.links[linkName], this.referringDocument.url);
      }
      return result;
    }

    /**
     * One or many [[ResourceIdentifierObject]]s defined in the `data` member of this relationship
     */
    @memoized()
    get data(): Spec.ResourceIdentifierObject | Spec.ResourceIdentifierObject[] | undefined | null {
      return this.rawData.data;
    }

    /**
     * The [[Document]] referred to by the `related` link in the `links` member of the relationship
     */
    @memoized()
    async relatedDocument(): Promise<Document | undefined> {
      if (this.links && 'related' in this.links) {
        return Document.fromURL(this.links['related'].url, this.context, this.referringDocument.sparseFields);
      }
    }

    /**
     * List of [[Resource]]s referenced by this relationship (if there are many resources).
     * @throws [[CardinalityError]] if there is only a singular resource.
     * @throws [[SchemaError]] if neither a `links` nor a `data` member is present
     */
    @memoized()
    async resources(): Promise<Resource[]> {
      if ('data' in this.rawData) {
        const resourceIdentifiers = this.data;
        if (resourceIdentifiers !== null && resourceIdentifiers !== undefined && !Array.isArray(resourceIdentifiers)) {
          throw new CardinalityError(
            'Relationship does not contain an array of resources. Use the `resource` method instead.'
          );
        }
        return Promise.resolve(
          (<Spec.ResourceIdentifierObject[]>resourceIdentifiers).map(
            rid => new RelatedResource(this.referringDocument, rid.id, rid.type, this.context)
          )
        );
      }
      const relatedDoc = await this.relatedDocument();
      if (relatedDoc) {
        return relatedDoc.resources;
      }
      throw new SchemaError('A relationship object relating to a resource must contain a `links` or `data` member');
    }

    /**
     * The one [[Resource]] referenced by this relationship.
     * @throws [[CardinalityError]] if there are many resources.
     * @throws [[SchemaError]] if neither a `links` nor a `data` member is present
     */
    @memoized()
    async resource(): Promise<Resource | null | undefined> {
      if ('data' in this.rawData) {
        const resourceIdentifier = this.data;
        if (resourceIdentifier !== null && resourceIdentifier !== undefined && Array.isArray(resourceIdentifier)) {
          throw new CardinalityError(
            'Relationship contains more than one resource. Use the `resources` method instead.'
          );
        }
        return Promise.resolve(
          new RelatedResource(
            this.referringDocument,
            (<Spec.ResourceIdentifierObject>resourceIdentifier).id,
            (<Spec.ResourceIdentifierObject>resourceIdentifier).type,
            this.context
          )
        );
      }
      const relatedDoc = await this.relatedDocument();
      if (relatedDoc) {
        return relatedDoc.resource;
      }
      throw new SchemaError('A relationship object relating to a resource must contain a `links` or `data` member');
    }
  }

  /**
   * Some helpers for constructing a document to POST to a server
   * @hidden
   */
  export class ClientDocument {
    private readonly rawData: Spec.ClientJsonApiDocument;

    constructor(resourceType: string, id?: string) {
      this.rawData = { data: { type: resourceType } };
      if (id !== undefined) {
        this.rawData.data.id = id;
      }
    }

    /** Sets a primary resource attribute @hidden */
    setAttribute(name: string, value: string) {
      if (!this.rawData.data.attributes) {
        this.rawData.data.attributes = {};
      }
      this.rawData.data.attributes[name] = value;
    }

    /** Adds a named relationship to a resource @hidden */
    setRelationship(
      name: string,
      ressourceIdentifier: Spec.ResourceIdentifierObject | Spec.ResourceIdentifierObject[]
    ) {
      if (!this.rawData.data.relationships) {
        this.rawData.data.relationships = {};
      }
      this.rawData.data.relationships[name] = { data: ressourceIdentifier };
    }

    /** Adds the resource to `included` @hidden */
    includeResource(resource: Spec.ResourceObject) {
      if (!this.rawData.included) {
        this.rawData.included = [];
      }
      this.rawData.included.push(resource);
    }

    /** Adds the resources to `included` @hidden */
    includeResources(resources: Spec.ResourceObject[]) {
      if (!this.rawData.included) {
        this.rawData.included = [];
      }
      this.rawData.included.push(...resources);
    }

    /** The raw JSON:API data @hidden */
    get data(): Spec.ClientJsonApiDocument {
      return this.rawData;
    }
  }
}
