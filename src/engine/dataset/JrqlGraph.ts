import { Iri } from 'jsonld/jsonld-spec';
import {
  Context, Read, Subject, Update, isDescribe, isGroup, isSubject, isUpdate,
  Group, isSelect, Result, Variable, Write, Constraint, Expression, operators,
  isConstraint, VariableExpression
} from '../../jrql-support';
import { NamedNode, Quad, Term } from 'rdf-js';
import { Graph, PatchQuads } from '.';
import { toArray, mergeMap, filter, take, groupBy, catchError } from 'rxjs/operators';
import { EMPTY, from, Observable, throwError } from 'rxjs';
import { canPosition, inPosition, TriplePos } from '../quads';
import { activeCtx, expandTerm } from "../jsonld";
import { Binding } from 'quadstore';
import { Algebra, Factory as SparqlFactory } from 'sparqlalgebrajs';
import { jrql } from '../../ns';
import { JrqlQuads } from './JrqlQuads';
import { MeldError } from '../MeldError';
import { any, array } from '../..';
import { asyncBinaryFold, flatten } from '../util';

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
    readonly defaultContext: Context = {}) {
    this.sparql = new SparqlFactory(graph);
    this.jrql = new JrqlQuads(graph);
  }

  read(query: Read,
    context: Context = query['@context'] || this.defaultContext): Observable<Subject> {
    if (isDescribe(query) && !Array.isArray(query['@describe'])) {
      return this.describe(query['@describe'], query['@where'], context);
    } else if (isSelect(query) && query['@where'] != null) {
      return this.select(query['@select'], query['@where'], context);
    } else {
      return throwError(new MeldError('Unsupported pattern', 'Read type not supported.'));
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
    throw new MeldError('Unsupported pattern', 'Write type not supported.');
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
    const describedVarName = jrql.matchVar(describe);
    if (describedVarName) {
      const vars = {
        subject: this.any(), property: this.any(),
        value: this.any(), item: this.any(),
        described: this.graph.variable(describedVarName)
      };
      return this.solutions(asGroup(where ?? {}), op =>
        this.graph.query(this.sparql.createProject(
          this.sparql.createJoin(
            // Sub-select DISTINCT to fetch subject ids
            this.sparql.createDistinct(
              this.sparql.createProject(
                this.sparql.createExtend(op, vars.subject,
                  this.sparql.createTermExpression(vars.described)),
                [vars.subject])),
            this.gatherSubjectData(vars)),
          [vars.subject, vars.property, vars.value, vars.item])), context).pipe(
            // TODO: Comunica bug? Cannot read property 'close' of undefined, if stream empty
            catchError(err => err instanceof TypeError ? EMPTY : throwError(err)),
            // TODO: Ordering annoyance: sometimes subjects interleave, so
            // cannot use toArrays(quad => quad.subject.value),
            groupBy(binding => this.bound(binding, vars.subject)),
            mergeMap(subjectBindings => subjectBindings.pipe(toArray())),
            mergeMap(subjectBindings => this.toSubject(subjectBindings, vars, context)));
    } else {
      return this.describe1(describe, context);
    }
  }

  describe1(describe: Iri,
    context: Context = this.defaultContext): Observable<Subject> {
    return from(this.resolve(describe, context)).pipe(mergeMap(subject => {
      const vars = { subject, property: this.any(), value: this.any(), item: this.any() };
      return this.graph.query(this.sparql.createProject(
        this.gatherSubjectData(vars), [vars.property, vars.value, vars.item]))
        .pipe(toArray(), mergeMap(bindings =>
          bindings.length ? this.toSubject(bindings, vars, context) : EMPTY));
    }))
  }

  private toSubject(bindings: Binding[], terms: SubjectTerms, context: Context): Promise<Subject> {
    // Partition the bindings into plain properties and list items
    return this.jrql.toApiSubject(...bindings.reduce<[Quad[], Quad[]]>((quads, binding) => {
      const [propertyQuads, listItemQuads] = quads, item = this.bound(binding, terms.item);
      (item == null ? propertyQuads : listItemQuads).push(this.graph.quad(
        inPosition('subject', this.bound(binding, terms.subject)),
        inPosition('predicate', this.bound(binding, terms.property)),
        inPosition('object', this.bound(binding, item == null ? terms.value : item)),
        this.graph.name))
      return quads;
    }, [[], []]), context);
  }

  private gatherSubjectData({ subject, property, value, item }: SubjectTerms): Algebra.Operation {
    /* {
      ?subject ?prop ?value
      optional { ?value <http://json-rql.org/#item> ?item }
    } */
    return this.sparql.createLeftJoin(
      // BGP to pick up all subject properties
      this.sparql.createBgp([this.sparql.createPattern(
        subject, property, value, this.graph.name)]),
      this.sparql.createBgp([this.sparql.createPattern(
        value, this.graph.namedNode(jrql.item), item, this.graph.name)]));
  }

  async find1<T>(jrqlPattern: Partial<T> & Subject,
    context: Context = jrqlPattern['@context'] ?? this.defaultContext): Promise<Iri | ''> {
    const quad = await this.findQuads(jrqlPattern, context).pipe(take(1)).toPromise();
    return quad?.subject.value ?? '';
  }

  findQuads(jrqlPattern: Subject, context: Context = this.defaultContext): Observable<Quad> {
    return from(this.jrql.quads(jrqlPattern, { mode: 'match' }, context)).pipe(
      mergeMap(quads => this.matchQuads(quads)));
  }

  async update(query: Update,
    context: Context = query['@context'] || this.defaultContext): Promise<PatchQuads> {
    let patch = new PatchQuads();

    const vars = new Set<string>();
    const deleteQuads = query['@delete'] != null ?
      await this.jrql.quads(query['@delete'], { mode: 'match', vars }, context) : undefined;
    const insertQuads = query['@insert'] != null ?
      await this.jrql.quads(query['@insert'], { mode: 'load' }, context) : undefined;

    let solutions: Observable<Binding> | null = null;
    if (query['@where'] != null) {
      // If there is a @where clause, use variable substitutions per solution
      solutions = this.solutions(asGroup(query['@where']), this.project, context);
    } else if (deleteQuads != null && vars.size > 0) {
      // A @delete clause with no @where may be used to bind variables
      solutions = this.project(
        this.sparql.createBgp(deleteQuads.map(this.toPattern)), vars);
    }
    if (solutions != null) {
      await solutions.forEach(solution => {
        // If there are variables in the update for which there is no value in the
        // solution, or if the solution value is not compatible with the quad
        // position, then this is treated as no-match, even if this is a
        // @delete (i.e. DELETEWHERE does not apply if @where exists).
        const matchingQuads = (template?: Quad[]) => template == null ? [] :
          this.fillTemplate(template, solution).filter(quad => !anyVarTerm(quad));
        patch.append(new PatchQuads({
          oldQuads: matchingQuads(deleteQuads),
          newQuads: matchingQuads(insertQuads)
        }));
      });
    } else if (!insertQuads?.some(anyVarTerm)) {
      // Both @delete and @insert have fixed quads, just apply them
      patch.append({ oldQuads: deleteQuads, newQuads: insertQuads });
    }
    return patch;
  }

  async definiteQuads(pattern: Subject | Subject[],
    context: Context = this.defaultContext) {
    const vars = new Set<string>();
    const quads = await this.jrql.quads(pattern, { mode: 'graph', vars }, context);
    if (vars.size > 0)
      throw new Error('Pattern has variable content');
    return quads;
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
    return from(this.operation(where, vars, context)).pipe(
      mergeMap(op => op == null ? EMPTY : exec(op, vars)));
  }

  private async operation(where: Group | Subject,
    vars: Set<string>, context: Context): Promise<Algebra.Operation> {
    if (isSubject(where)) {
      const quads = await this.jrql.quads(where, { mode: 'match', vars }, context);
      return this.sparql.createBgp(quads.map(this.toPattern));
    } else {
      const graph = array(where['@graph']),
        union = array(where['@union']),
        filter = array(where['@filter']),
        values = array(where['@values']);
      const quads = graph.length ? await this.jrql.quads(
        graph, { mode: 'match', vars }, context) : [];
      const bgp = this.sparql.createBgp(quads.map(this.toPattern));
      const unionOp = await asyncBinaryFold(union,
        pattern => this.operation(pattern, vars, context),
        (left, right) => this.sparql.createUnion(left, right));
      const unioned = unionOp && bgp.patterns.length ?
        this.sparql.createJoin(bgp, unionOp) : unionOp ?? bgp;
      const filtered = filter.length ? this.sparql.createFilter(
        unioned, await this.constraintExpr(filter, context)) : unioned;
      const valued = values.length ? this.sparql.createJoin(
        await this.valuesExpr(values, context), filtered) : filtered;
      return valued;
    }
  }

  private async valuesExpr(
    values: VariableExpression[], context: Context): Promise<Algebra.Operation> {
    const variableNames = new Set<string>();
    const variablesTerms = await Promise.all(values.map<Promise<{ [variable: string]: Term }>>(
      variableExpr => Object.entries(variableExpr).reduce<Promise<{ [variable: string]: Term; }>>(
        async (variableTerms, [variable, expr]) => {
          const varName = jrql.matchVar(variable);
          if (!varName)
            throw new Error('Variable not specified in a values expression');
          variableNames.add(varName);
          if (isConstraint(expr))
            throw new Error('Cannot use constraint in a values expression');
          return {
            ...await variableTerms,
            [variable]: (await this.jrql.toObjectTerms(expr, context))[0]
          };
        }, Promise.resolve({}))));

    return this.sparql.createValues(
      [...variableNames].map(this.graph.variable), variablesTerms);
  }

  private async constraintExpr(
    constraints: Constraint[], context: Context): Promise<Algebra.Expression> {
    const expression = await asyncBinaryFold(
      // Every constraint and every entry in a constraint is ANDed
      flatten(constraints.map(constraint => Object.entries(constraint))),
      ([operator, expr]) => this.operatorExpr(operator, expr, context),
      (left, right) => this.sparql.createOperatorExpression('and', [left, right]));
    if (expression == null)
      throw new Error('Missing expression');
    return expression;
  }

  private async operatorExpr(
    operator: string,
    expr: Expression | Expression[],
    context: Context): Promise<Algebra.Expression> {
    if (operator in operators)
      return this.sparql.createOperatorExpression(
        (<any>operators)[operator].sparql,
        await Promise.all(array(expr).map(expr => this.exprExpr(expr, context))));
    else
      throw new Error(`Unrecognised operator: ${operator}`);
  }

  private async exprExpr(
    expr: Expression, context: Context): Promise<Algebra.Expression> {
    if (isConstraint(expr)) {
      return this.constraintExpr([expr], context);
    } else {
      const varName = typeof expr == 'string' && jrql.matchVar(expr);
      return this.sparql.createTermExpression(varName ?
        this.graph.variable(varName) : (await this.jrql.toObjectTerms(expr, context))[0]);
    }
  }

  private project = (op: Algebra.Operation, vars: Iterable<string>): Observable<Binding> => {
    return this.graph.query(this.sparql.createProject(op,
      [...vars].map(varName => this.graph.variable(varName))));
  }

  private fillTemplate(quads: Quad[], binding: Binding): Quad[] {
    return quads.map(quad => this.graph.quad(
      this.fillTemplatePos('subject', quad.subject, binding),
      this.fillTemplatePos('predicate', quad.predicate, binding),
      this.fillTemplatePos('object', quad.object, binding)));
  }

  private fillTemplatePos<P extends TriplePos>(pos: P, term: Quad[P], binding: Binding): Quad[P] {
    switch (term.termType) {
      case 'Variable':
        const value = this.bound(binding, term);
        if (value != null && canPosition(pos, value))
          return value;
    }
    return term;
  }

  private async resolve(iri: Iri, context?: Context): Promise<NamedNode> {
    return this.graph.namedNode(context ? expandTerm(iri, await activeCtx(context)) : iri);
  }

  private bound(binding: Binding, term: Term): Term | undefined {
    switch (term.termType) {
      case 'Variable':
        const value = binding[`?${term.value}`];
        if (value != null)
          return value;

        // If this variable is a sub-variable, see if the parent variable is bound
        const [varName, subVarName] = jrql.matchSubVarName(term.value);
        const genValue = subVarName != null ?
          this.jrql.genSubValue(binding[`?${varName}`], subVarName) : null;
        if (genValue != null)
          // Cache the generated value in the binding
          return binding[`?${term.value}`] = genValue;
        break; // Not bound

      default:
        return term;
    }
  }

  private any() {
    return this.graph.variable(any().slice(1));
  }
}

interface SubjectTerms {
  subject: Term;
  property: Term;
  value: Term;
  item: Term;
}

function anyVarTerm(quad: Quad) {
  return ['subject', 'predicate', 'object']
    .some((pos: TriplePos) => quad[pos].termType === 'Variable');
}

function asGroup(where: Subject | Subject[] | Group): Group {
  return Array.isArray(where) ? { '@graph': where } :
    isGroup(where) ? where : { '@graph': where };
}
