import { Iri } from 'jsonld/jsonld-spec';
import {
  Context, Read, Subject, Update, isDescribe, isGroup, isSubject, isUpdate,
  Group, isSelect, Result, Variable, Write} from '../../jrql-support';
import { DataFactory, NamedNode, Quad } from 'rdf-js';
import { Graph, PatchQuads } from '.';
import { toArray, mergeMap, filter, take, groupBy, catchError } from 'rxjs/operators';
import { EMPTY, from, Observable, throwError } from 'rxjs';
import { array } from '../../util';
import { canPosition, TriplePos } from '../quads';
import { activeCtx, expandTerm } from "../jsonld";
import { Binding } from 'quadstore';
import { Algebra, Factory as SparqlFactory } from 'sparqlalgebrajs';
import { genVarName, JrqlQuads, matchVar, toSubject } from './JrqlQuads';

/**
 * A graph wrapper that provides low-level json-rql handling for queries. The
 * write methods don't actually make changes but produce Patches which can then
 * be applied to a Dataset.
 */
export class JrqlGraph {
  sparql: SparqlFactory;
  jrql: JrqlQuads;

  /**
   * @param graph a quads graph to operate on
   * @param defaultContext default context for interpreting JSON patterns
   * @param base Iri for minting new Iris. Not necessarily the same as
   * `defaultContext.@base`
   */
  constructor(
    readonly graph: Graph,
    readonly defaultContext: Context = {},
    readonly base?: Iri) {
    this.sparql = new SparqlFactory(graph.dataFactory);
    this.jrql = new JrqlQuads(this.rdf, this.graph.name, base);
  }

  /** Convenience for RDF algebra construction */
  get rdf(): Required<DataFactory> {
    return this.graph.dataFactory;
  }

  read(query: Read,
    context: Context = query['@context'] || this.defaultContext): Observable<Subject> {
    if (isDescribe(query) && !Array.isArray(query['@describe'])) {
      return this.describe(query['@describe'], query['@where'], context);
    } else if (isSelect(query) && query['@where'] != null) {
      return this.select(query['@select'], query['@where'], context);
    } else {
      return throwError(new Error('Read type not supported.'));
    }
  }

  async write(query: Write,
    context: Context = query['@context'] || this.defaultContext): Promise<PatchQuads> {
    // @unions not supported unless in a where clause
    if (isGroup(query) && query['@graph'] != null && query['@union'] == null) {
      return this.write({ '@insert': query['@graph'] } as Update, context);
    } else if (isSubject(query)) {
      return this.write({ '@insert': query } as Update, context);
    } else if (isUpdate(query)) {
      return this.update(query, context);
    }
    throw new Error('Write type not supported.');
  }

  select(select: Result,
    where: Subject | Subject[] | Group,
    context: Context = this.defaultContext): Observable<Subject> {
    return this.solutions(asGroup(where), this.project, context).pipe(
      mergeMap(solution => this.jrql.solutionSubject(select, solution, context)));
  }

  describe(describe: Iri | Variable,
    where?: Subject | Subject[] | Group,
    context: Context = this.defaultContext): Observable<Subject> {
    const sVarName = matchVar(describe);
    if (sVarName) {
      const outerVar = this.rdf.variable(genVarName());
      return this.solutions(asGroup(where ?? {}), op =>
        // Sub-select using DISTINCT to fetch subject ids
        this.graph.query(this.sparql.createDescribe(
          this.sparql.createDistinct(
            this.sparql.createProject(
              this.sparql.createExtend(op, outerVar,
                this.sparql.createTermExpression(this.rdf.variable(sVarName))),
              [outerVar])),
          [outerVar])), context).pipe(
            // TODO: Comunica bug? Cannot read property 'close' of undefined, if stream empty
            catchError(err => err instanceof TypeError ? EMPTY : throwError(err)),
            // TODO: Comunica bug? Describe sometimes interleaves subjects, so cannot use
            // toArrays(quad => quad.subject.value),
            groupBy(quad => quad.subject.value),
            mergeMap(subjectQuads => subjectQuads.pipe(toArray())),
            mergeMap(subjectQuads => toSubject(subjectQuads, context)));
    } else {
      return from(this.describe1(describe, context)).pipe(
        filter<Subject>(subject => subject != null));
    }
  }

  async describe1<T extends object>(describe: Iri, context: Context = this.defaultContext): Promise<T | undefined> {
    const quads = await this.graph.match(await this.resolve(describe, context)).pipe(toArray()).toPromise();
    quads.forEach(quad => quad.graph = this.rdf.defaultGraph());
    return quads.length ? <T>await toSubject(quads, context) : undefined;
  }

  async find1<T>(jrqlPattern: Partial<T> & Subject,
    context: Context = jrqlPattern['@context'] ?? this.defaultContext): Promise<Iri | ''> {
    const quad = await this.findQuads(jrqlPattern, context).pipe(take(1)).toPromise();
    return quad?.subject.value ?? '';
  }

  findQuads(jrqlPattern: Subject, context: Context = this.defaultContext): Observable<Quad> {
    return from(this.jrql.quads(jrqlPattern, { query: true }, context)).pipe(
      mergeMap(quads => this.matchQuads(quads)));
  }

  async update(query: Update,
    context: Context = query['@context'] || this.defaultContext): Promise<PatchQuads> {
    let patch = new PatchQuads([], []);
    // If there is a @where clause, use variable substitutions per solution.
    if (query['@where'] != null) {
      const deleteTemplate = query['@delete'] != null ?
        await this.jrql.quads(query['@delete'], { query: true }, context) : null;
      const insertTemplate = query['@insert'] != null ?
        await this.jrql.quads(query['@insert'], { query: false }, context) : null;
      await this.solutions(asGroup(query['@where']), this.project, context).forEach(solution => {
        const matchingQuads = (template: Quad[] | null) => {
          // If there are variables in the update for which there is no value in the
          // solution, or if the solution value is not compatible with the quad
          // position, then this is treated as no-match, even if this is a
          // `@delete` (i.e. DELETEWHERE does not apply).
          return template != null ? this.fillTemplate(template, solution)
            .filter(quad => !anyVarTerm(quad)) : [];
        }
        patch.append(new PatchQuads(
          matchingQuads(deleteTemplate), matchingQuads(insertTemplate)));
      });
    } else {
      if (query['@delete'])
        patch.append(await this.delete(query['@delete'], context));
      if (query['@insert'])
        patch.append(await this.insert(query['@insert'], context));
    }
    return patch;
  }

  /**
   * This is shorthand for a `@insert` update with no `@where`. It requires
   * there to be no variables in the `@insert`.
   */
  async insert(insert: Subject | Subject[],
    context: Context = this.defaultContext): Promise<PatchQuads> {
    const vars = new Set<string>();
    const quads = await this.jrql.quads(insert, { query: false, vars }, context);
    if (vars.size > 0)
      throw new Error('Cannot insert with variable content');
    return new PatchQuads([], quads);
  }

  /**
   * This is shorthand for a `@delete` update with no `@where`. It supports
   * SPARQL DELETEWHERE semantics, matching any variables against the data.
   */
  async delete(dels: Subject | Subject[],
    context: Context = this.defaultContext): Promise<PatchQuads> {
    const vars = new Set<string>();
    const patterns = await this.jrql.quads(dels, { query: true, vars }, context);
    // If there are no variables in the delete, we don't need to find solutions
    return new PatchQuads(vars.size > 0 ?
      await this.matchQuads(patterns).pipe(toArray()).toPromise() : patterns, []);
  }

  private toPattern = (quad: Quad): Algebra.Pattern => {
    return this.sparql.createPattern(
      quad.subject, quad.predicate, quad.object, quad.graph);
  }

  private matchQuads(quads: Quad[]): Observable<Quad> {
    const patterns = quads.map(this.toPattern);
    // CONSTRUCT <quads> WHERE <quads>
    return this.graph.query(this.sparql.createConstruct(
      this.sparql.createBgp(patterns), patterns));
  }

  private solutions<T>(where: Group,
    exec: (op: Algebra.Operation, vars: Iterable<string>) => Observable<T>,
    context: Context): Observable<T> {
    const vars = new Set<string>();
    return from(unions(where).reduce<Promise<Algebra.Operation | null>>(async (opSoFar, graph) => {
      const left = await opSoFar;
      const quads = await this.jrql.quads(graph, { query: true, vars }, context);
      const right = this.sparql.createBgp(quads.map(this.toPattern));
      return left != null ? this.sparql.createUnion(left, right) : right;
    }, Promise.resolve(null))).pipe(mergeMap(op => op == null ? EMPTY : exec(op, vars)));
  }

  private project = (op: Algebra.Operation, vars: Iterable<string>): Observable<Binding> => {
    return this.graph.query(this.sparql.createProject(op,
      [...vars].map(varName => this.rdf.variable(varName))));
  }

  private fillTemplate(quads: Quad[], varValues: Binding): Quad[] {
    return quads.map(quad => this.rdf.quad(
      this.fillTemplatePos('subject', quad.subject, varValues),
      this.fillTemplatePos('predicate', quad.predicate, varValues),
      this.fillTemplatePos('object', quad.object, varValues),
      quad.graph));
  }

  private fillTemplatePos<P extends TriplePos>(pos: P, term: Quad[P], varValues: Binding): Quad[P] {
    switch (term.termType) {
      case 'Variable':
        const value = varValues[`?${term.value}`];
        if (value != null && canPosition(pos, value))
          return value;
    }
    return term;
  }

  private async resolve(iri: Iri, context?: Context): Promise<NamedNode> {
    return this.rdf.namedNode(context ? expandTerm(iri, await activeCtx(context)) : iri);
  }
}

function anyVarTerm(quad: Quad) {
  return ['subject', 'predicate', 'object']
    .some((pos: TriplePos) => quad[pos].termType === 'Variable');
}

function asGroup(where: Subject | Subject[] | Group): Group {
  return Array.isArray(where) ? { '@graph': where } :
    isGroup(where) ? where : { '@graph': where };
}

function unions(where: Group): Subject[][] {
  // A Group can technically have both a @graph and a @union
  const graph = array(where['@graph']);
  if (where['@union'] != null) {
    // Top-level graph intersects with each union
    return where['@union'].map(subject => array(subject).concat(graph))
  } else {
    return [graph];
  }
}
