import { Subject } from '../src';
import { DatasetClone } from '../src/dataset/DatasetClone';
import { memStore, mockRemotes, testConfig } from './testClones';
import { SingleValued } from '../src/constraints/SingleValued'; 

describe('Single-valued constraint', () => {
  let data: DatasetClone;

  beforeEach(async () => {
    data = new DatasetClone(await memStore(), mockRemotes(), testConfig());
    await data.initialise();
  });

  test('Passes an empty update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.check({
      '@ticks': 0,
      '@delete': [],
      '@insert': []
    }, query => data.transact(query))).resolves.toBeUndefined();
  });

  test('Passes a missing property update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.check({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#height': 5 }]
    }, query => data.transact(query))).resolves.toBeUndefined();
  });

  test('Passes a single-valued property update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.check({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Fred' }]
    }, query => data.transact(query))).resolves.toBeUndefined();
  });

  test('Fails a multi-valued property update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.check({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': ['Fred', 'Flintstone'] }]
    }, query => data.transact(query))).rejects.toBeDefined();
  });

  test('Fails a single-valued additive property update', async () => {
    await data.transact(<Subject>{
      '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Fred'
    }).toPromise();

    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.check({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Flintstone' }]
    }, query => data.transact(query))).rejects.toBeDefined();
  });

  test('does not apply to a single-valued property update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.apply({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Fred' }]
    }, query => data.transact(query))).resolves.toBeNull();
  });

  test('applies to a multi-valued property update', async () => {
    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.apply({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': ['Fred', 'Flintstone'] }]
    }, query => data.transact(query))).resolves.toEqual({
      '@delete': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': ['Flintstone'] }],
      '@insert': []
    });
  });

  test('applies to a single-valued additive property update', async () => {
    await data.transact(<Subject>{
      '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Fred'
    }).toPromise();

    const constraint = new SingleValued('http://test.m-ld.org/#name');
    await expect(constraint.apply({
      '@ticks': 0,
      '@delete': [],
      '@insert': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': 'Flintstone' }]
    }, query => data.transact(query))).resolves.toEqual({
      '@delete': [{ '@id': 'http://test.m-ld.org/fred', 'http://test.m-ld.org/#name': ['Flintstone'] }],
      '@insert': []
    });
  });
});