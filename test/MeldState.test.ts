import { any, MeldUpdate } from '../src/api';
import { ApiStateMachine } from '../src/engine/MeldState';
import { memStore, mockRemotes, testConfig } from './testClones';
import { DatasetEngine } from '../src/engine/dataset/DatasetEngine';
import { Group, Subject, Select, Describe, Update, Reference, Construct } from '../src/jrql-support';
import { DomainContext } from '../src/engine/MeldEncoding';
import { Future } from '../src/engine/util';
import { blankRegex, genIdRegex } from './testUtil';
import { SubjectGraph } from '../src/engine/SubjectGraph';

describe('Meld State API', () => {
  let api: ApiStateMachine;
  let captureUpdate: Future<MeldUpdate>;

  beforeEach(async () => {
    const context = new DomainContext('test.m-ld.org');
    let clone = new DatasetEngine({
      dataset: await memStore({ context }),
      remotes: mockRemotes(),
      config: testConfig()
    });
    await clone.initialise();
    api = new ApiStateMachine(context, clone);
    captureUpdate = new Future;
  });

  test('retrieves a JSON-LD subject', async () => {
    api.follow(captureUpdate.resolve);
    await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
    await expect(captureUpdate).resolves.toEqual({
      '@ticks': 1,
      '@insert': new SubjectGraph([{ '@id': 'fred', name: 'Fred' }]),
      '@delete': new SubjectGraph([])
    });
    await expect(api.get('fred'))
      .resolves.toEqual({ '@id': 'fred', name: 'Fred' });
  });

  describe('basic writes', () => {
    test('deletes a subject by update', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({ '@delete': { '@id': 'fred' } });
      await expect(api.get('fred')).resolves.toBeUndefined();
      await expect(captureUpdate).resolves.toEqual({
        '@ticks': 2,
        '@delete': [{ '@id': 'fred', name: 'Fred' }],
        '@insert': []
      });
    });

    test('deletes a property by update', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', height: 5 });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({ '@delete': { '@id': 'fred', height: 5 } });
      await expect(api.get('fred'))
        .resolves.toEqual({ '@id': 'fred', name: 'Fred' });
      await expect(captureUpdate).resolves.toEqual({
        '@ticks': 2,
        '@delete': [{ '@id': 'fred', height: 5 }],
        '@insert': []
      });
    });

    test('deletes where any', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', height: 5 });
      await api.write<Update>({ '@delete': { '@id': 'fred', height: any() } });
      await expect(api.get('fred'))
        .resolves.toEqual({ '@id': 'fred', name: 'Fred' });
    });

    test('updates a property', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', height: 5 });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({
        '@delete': { '@id': 'fred', height: 5 },
        '@insert': { '@id': 'fred', height: 6 }
      });
      await expect(api.get('fred'))
        .resolves.toEqual({ '@id': 'fred', name: 'Fred', height: 6 });
      await expect(captureUpdate).resolves.toEqual({
        '@ticks': 2,
        '@delete': [{ '@id': 'fred', height: 5 }],
        '@insert': [{ '@id': 'fred', height: 6 }]
      });
    });

    test('delete where must match all', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', height: 5 });
      // This write has no effect because we're asking for triples with subject of
      // both fred and bambam
      await api.write<Update>({
        '@delete': [{ '@id': 'fred', height: 5 }, { '@id': 'bambam' }]
      });
      await expect(api.get('fred'))
        .resolves.toEqual({ '@id': 'fred', name: 'Fred', height: 5 });
    });

    test('inserts a subject by update', async () => {
      api.follow(captureUpdate.resolve);
      await api.write<Update>({ '@insert': { '@id': 'fred', name: 'Fred' } });
      await expect(api.get('fred')).resolves.toBeDefined();
      await expect(captureUpdate).resolves.toEqual({
        '@ticks': 1,
        '@delete': [],
        '@insert': [{ '@id': 'fred', name: 'Fred' }]
      });
    });

    test('deletes a subject by path', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      api.follow(captureUpdate.resolve);
      await api.delete('fred');
      await expect(api.get('fred')).resolves.toBeUndefined();
      await expect(captureUpdate).resolves.toEqual({
        '@ticks': 2,
        '@delete': [{ '@id': 'fred', name: 'Fred' }],
        '@insert': []
      });
    });

    test('deletes a property by path', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', wife: { '@id': 'wilma' } });
      await api.delete('wilma');
      await expect(api.get('fred')).resolves.toEqual({ '@id': 'fred', name: 'Fred' });
    });

    test('deletes an object by path', async () => {
      await api.write<Subject>({ '@id': 'fred', wife: { '@id': 'wilma' } });
      await api.delete('wilma');
      await expect(api.get('fred')).resolves.toBeUndefined();
    });
  });

  describe('basic reads', () => {
    test('selects where', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Select>({
        '@select': '?f', '@where': { '@id': '?f', name: 'Fred' }
      })).resolves.toMatchObject([{ '?f': { '@id': 'fred' } }]);
    });

    test('selects where union', async () => {
      await api.write<Group>({
        '@graph': [
          { '@id': 'fred', name: 'Fred' },
          { '@id': 'wilma', name: 'Wilma' }
        ]
      });
      await expect(api.read<Select>({
        '@select': '?s', '@where': {
          '@union': [
            { '@id': '?s', name: 'Wilma' },
            { '@id': '?s', name: 'Fred' }
          ]
        }
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ '?s': { '@id': 'fred' } }),
        expect.objectContaining({ '?s': { '@id': 'wilma' } })
      ]));
    });

    test('selects not found', async () => {
      await api.write({ '@id': 'fred', name: 'Fred' } as Subject);
      await expect(api.read<Select>({
        '@select': '?w', '@where': { '@id': '?w', name: 'Wilma' }
      })).resolves.toEqual([]);
    });

    test('describes where', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Describe>({
        '@describe': '?f', '@where': { '@id': '?f', name: 'Fred' }
      })).resolves.toEqual([{ '@id': 'fred', name: 'Fred' }]);
    });

    test('describes with boolean value', async () => {
      await api.write<Subject>({ '@id': 'fred', married: true });
      await expect(api.read<Describe>({ '@describe': 'fred' }))
        .resolves.toEqual([{ '@id': 'fred', married: true }]);
    });

    test('describes with double value', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', age: 40.5 });
      await expect(api.read<Describe>({ '@describe': 'fred' }))
        .resolves.toMatchObject([{ '@id': 'fred', name: 'Fred', age: 40.5 }]);
    });

    test('constructs basic match', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'fred', name: '?' }
      })).resolves.toMatchObject([{
        '@id': 'fred', name: 'Fred'
      }]);
    });

    test('constructs where', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { name: '?name' },
        '@where': { '@id': 'fred', name: '?name' }
      })).resolves.toMatchObject([{
        '@id': expect.stringMatching(blankRegex),
        name: 'Fred'
      }]);
    });

    test('constructs where two matches', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { name: '?name' },
        '@where': { name: '?name' }
      })).resolves.toMatchObject([{
        '@id': expect.stringMatching(blankRegex),
        name: expect.arrayContaining(['Fred', 'Wilma'])
      }]);
    });

    test('constructs new ID from existing', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'fake', name: '?name' },
        '@where': { '@id': 'fred', name: '?name' }
      })).resolves.toMatchObject([{
        '@id': 'fake', name: 'Fred'
      }]);
    });

    test('constructs two matches', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { name: '?' }
      })).resolves.toMatchObject([{
        '@id': expect.stringMatching(blankRegex),
        name: expect.arrayContaining(['Fred', 'Wilma'])
      }]);
    });

    test('constructs two identified matches', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': '?', name: '?' }
      })).resolves.toMatchObject(expect.arrayContaining([
        { '@id': 'fred', name: 'Fred' },
        { '@id': 'wilma', name: 'Wilma' }
      ]));
    });

    test('constructs with two matched properties', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', height: 6 });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'fred', '?': '?' }
      })).resolves.toMatchObject([{
        '@id': 'fred', name: 'Fred', height: 6
      }]);
    });

    test('constructs with nested subject', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', wife: { '@id': 'wilma' } });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'fred', wife: { name: '?' } }
      })).resolves.toMatchObject([{
        '@id': 'fred', wife: { name: 'Wilma' }
      }]);
    });

    test('constructs with overlapping bindings', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred', wife: { '@id': 'wilma' } });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'fred', '?': '?', wife: { '@id': '?', name: '?' } }
      })).resolves.toMatchObject([{
        '@id': 'fred', name: 'Fred',
        // Comes from both '?' and wife property matches
        wife: { '@id': 'wilma', name: 'Wilma' }
      }]);
    });

    test('constructs list', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Bread', 'Milk'] });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'shopping', '@list': { '?': '?' } }
      })).resolves.toMatchObject([{
        '@id': 'shopping', '@list': { '0': 'Bread', '1': 'Milk' }
      }]);
    });

    test('constructs item from list', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Bread', 'Milk'] });
      await expect(api.read<Construct>({
        '@construct': { '@id': 'shopping', '@list': { 1: '?' } }
      })).resolves.toMatchObject([{
        '@id': 'shopping', '@list': { '1': 'Milk' }
      }]);
    });
  });

  describe('filters', () => {
    test('selects name equal', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f', name: '?n' },
          '@filter': { '@eq': ['?n', 'Fred'] }
        }
      });
      expect(selection).toEqual([{
        '@id': expect.stringMatching(blankRegex),
        '?f': { '@id': 'fred' }
      }]);
    });

    test('selects name in', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await api.write<Subject>({ '@id': 'barney', name: 'Barney' });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f', name: '?n' },
          '@filter': { '@in': ['?n', 'Fred', 'Wilma'] }
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'fred' } },
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'wilma' } }
      ]));
    });

    test('selects @id in', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await api.write<Subject>({ '@id': 'barney', name: 'Barney' });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f' },
          '@filter': { '@in': ['?f', { '@id': 'fred' }, { '@id': 'wilma' }] }
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'fred' } },
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'wilma' } }
      ]));
    });

    test('selects @id from values', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await api.write<Subject>({ '@id': 'barney', name: 'Barney' });
      const selection = await api.read<Select>({
        '@select': '?n',
        '@where': {
          '@graph': { '@id': '?f', name: '?n' },
          '@values': [{ '?f': { '@id': 'fred' } }, { '?f': { '@id': 'wilma' } }]
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?n': 'Fred' },
        { '@id': expect.stringMatching(blankRegex), '?n': 'Wilma' }
      ]));
    });

    test('selects name or other name', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await api.write<Subject>({ '@id': 'barney', name: 'Barney' });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f', name: '?n' },
          '@filter': { '@or': [{ '@eq': ['?n', 'Fred'] }, { '@eq': ['?n', 'Wilma'] }] }
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'fred' } },
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'wilma' } }
      ]));
    });

    test('selects string gte', async () => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      await api.write<Subject>({ '@id': 'wilma', name: 'Wilma' });
      await api.write<Subject>({ '@id': 'barney', name: 'Barney' });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f', name: '?n' },
          '@filter': { '@gte': ['?n', 'Fred'] }
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'fred' } },
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'wilma' } }
      ]));
    });

    test('selects number gte', async () => {
      await api.write<Subject>({ '@id': 'fred', height: 6 });
      await api.write<Subject>({ '@id': 'wilma', height: 5 });
      await api.write<Subject>({ '@id': 'barney', height: 4 });
      const selection = await api.read<Select>({
        '@select': '?f',
        '@where': {
          '@graph': { '@id': '?f', height: '?h' },
          '@filter': { '@gte': ['?h', 5] }
        }
      });
      expect(selection.length).toBe(2);
      expect(selection).toEqual(expect.arrayContaining([
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'fred' } },
        { '@id': expect.stringMatching(blankRegex), '?f': { '@id': 'wilma' } }
      ]));
    });
  });

  describe('anonymous subjects', () => {
    test('describes an anonymous subject', async () => {
      await api.write<Update>({ '@insert': { name: 'Fred', height: 5 } });
      await expect(api.read<Describe>({
        '@describe': '?s', '@where': { '@id': '?s', name: 'Fred' }
      })).resolves.toEqual([{ '@id': expect.stringMatching(genIdRegex), name: 'Fred', height: 5 }]);
    });

    test('selects anonymous subject properties', async () => {
      await api.write<Update>({ '@insert': { name: 'Fred', height: 5 } });
      await expect(api.read<Select>({
        '@select': '?h', '@where': { name: 'Fred', height: '?h' }
      })).resolves.toMatchObject([{ '?h': 5 }]);
    });

    test('describes an anonymous nested subject', async () => {
      await api.write<Subject>({ '@id': 'fred', stats: { height: 5, age: 40 } });
      await expect(api.read<Describe>({
        '@describe': '?stats', '@where': { '@id': 'fred', stats: { '@id': '?stats' } }
      })).resolves.toEqual([{ '@id': expect.stringMatching(genIdRegex), height: 5, age: 40 }]);
    });

    test('does not merge anonymous nested subjects', async () => {
      await api.write<Subject>({ '@id': 'fred', stats: { height: 5 } });
      await api.write<Subject>({ '@id': 'fred', stats: { age: 40 } });
      await expect(api.read<Describe>({
        '@describe': '?stats', '@where': { '@id': 'fred', stats: { '@id': '?stats' } }
      })).resolves.toMatchObject(expect.arrayContaining([
        { '@id': expect.stringMatching(genIdRegex), height: 5 },
        { '@id': expect.stringMatching(genIdRegex), age: 40 }
      ]));
    });

    test('matches anonymous subject property in delete-where', async () => {
      await api.write<Subject>({ '@id': 'fred', height: 5, age: 40 });
      await api.write<Update>({ '@delete': { height: 5 } })
      await expect(api.read<Describe>({
        '@describe': 'fred',
      })).resolves.toEqual([{ '@id': 'fred', age: 40 }]);
    });

    test('matches nested property in delete-where', async () => {
      await api.write<Subject>({ '@id': 'fred', stats: { height: 5, age: 40 } });
      await api.write<Update>({ '@delete': { '@id': 'fred', stats: { height: 5 } } })
      // Scary case for documentation: DELETEWHERE is aggressive
      await expect(api.read<Describe>({
        '@describe': '?stats', '@where': { '@id': 'fred', stats: { '@id': '?stats' } }
      })).resolves.toEqual([]);
    });

    test('matches nested property with explicit where', async () => {
      await api.write<Subject>({ '@id': 'fred', stats: { height: 5, age: 40 } });
      await api.write<Update>({
        '@delete': { '@id': '?stats', height: 5 },
        '@where': { '@id': 'fred', stats: { '@id': '?stats', height: 5 } }
      })
      await expect(api.read<Describe>({
        '@describe': '?stats', '@where': { '@id': 'fred', stats: { '@id': '?stats' } }
      })).resolves.toEqual([{ '@id': expect.stringMatching(genIdRegex), age: 40 }]);
    });

    test('imports web-app configuration', async () => {
      await api.write<Subject>(require('./web-app.json'));
      // Do some checks to ensure the data is present
      await expect(api.read<Select>({
        '@select': '?id',
        '@where': { '@id': '?id' }
      })).resolves.toMatchObject(
        // Note 85 quads total (not distinct)
        new Array(85).fill({ '?id': { '@id': expect.stringMatching(genIdRegex) } }));
      await expect(api.read<Describe>({
        '@describe': '?id',
        '@where': { '@id': '?id' }
      })).resolves.toMatchObject(
        new Array(12).fill({ '@id': expect.stringMatching(genIdRegex) }));
      await expect(api.read<Describe>({
        '@describe': '?id',
        '@where': { '@id': '?id', 'servlet-name': 'fileServlet' }
      })).resolves.toEqual([{
        '@id': expect.stringMatching(genIdRegex),
        'servlet-class': 'org.cofax.cds.FileServlet',
        'servlet-name': 'fileServlet'
      }]);
      await expect(api.read<Select>({
        '@select': '?a',
        '@where': {
          'servlet': {
            'init-param': {
              'dataStoreName': 'cofax',
              'configGlossary:adminEmail': '?a'
            }
          }
        }
      })).resolves.toMatchObject([{ '?a': 'ksm@pobox.com' }]);
    });
  });

  describe('lists', () => {
    test('inserts a list as a property', async () => {
      api.follow(captureUpdate.resolve);
      await api.write<Subject>({
        '@id': 'fred', shopping: { '@list': ['Bread', 'Milk'] }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'fred',
        shopping: {
          '@id': expect.stringMatching(genIdRegex),
          '@type': 'http://m-ld.org/RdfLseq',
          '@list': {
            0: [
              { '@id': expect.stringMatching(genIdRegex), '@item': 'Bread', '@index': 0 },
              { '@id': expect.stringMatching(genIdRegex), '@item': 'Milk', '@index': 1 }
            ]
          }
        }
      });
      const fred = (await api.read<Describe>({ '@describe': 'fred' }))[0];
      expect(fred).toMatchObject({
        '@id': 'fred', shopping: { '@id': expect.stringMatching(genIdRegex) }
      });
      const listId = (<any>fred.shopping)['@id'];
      await expect(api.read<Describe>({ '@describe': listId })).resolves.toMatchObject([{
        '@id': listId,
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
    });

    test('inserts an identified list', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': ['Bread', 'Milk']
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
    });

    test('inserts an identified with index notation', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: 'Bread', 1: 'Milk' }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
    });

    test('appends to a list', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: 'Bread' }
      });
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 1: 'Milk' }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
    });

    test('appends beyond the end of a list', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': ['Bread']
      });
      api.follow(captureUpdate.resolve);
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 2: 'Milk' }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          1: [{ '@id': expect.stringMatching(genIdRegex), '@item': 'Milk', '@index': 1 }]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
    });

    test('prepends to a list', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: 'Milk' }
      });
      api.follow(captureUpdate.resolve);
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: 'Bread' }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          0: [{ '@id': expect.stringMatching(genIdRegex), '@item': 'Bread', '@index': 0 }]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Milk']
      }]);
      // This checks that the slots have been correctly re-numbered
      await expect(api.read<Select>({
        '@select': ['?0', '?1'],
        '@where': { '@id': 'shopping', '@list': { 0: '?0', 1: '?1' } }
      })).resolves.toMatchObject([{
        '?0': 'Bread',
        '?1': 'Milk'
      }]);
    });

    test('prepends multiple items to a list', async () => {
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: 'Milk' }
      });
      api.follow(captureUpdate.resolve);
      await api.write<Subject>({
        '@id': 'shopping', '@list': { 0: ['Bread', 'Candles'] }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          0: [
            { '@id': expect.stringMatching(genIdRegex), '@item': 'Bread', '@index': 0 },
            { '@id': expect.stringMatching(genIdRegex), '@item': 'Candles', '@index': 1 }
          ]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' })).resolves.toMatchObject([{
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': ['Bread', 'Candles', 'Milk']
      }]);
    });

    test('finds by index in a list', async () => {
      await api.write<Group>({
        '@graph': [
          { '@id': 'shopping1', '@list': ['Bread', 'Milk'] },
          { '@id': 'shopping2', '@list': ['Milk', 'Spam'] }
        ]
      });
      await expect(api.read<Select>({
        '@select': '?list',
        '@where': {
          '@id': '?list',
          '@list': { 1: 'Milk' }
        }
      })).resolves.toMatchObject([{
        '?list': { '@id': 'shopping1' }
      }]);
    });

    test('selects item from a list', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk'] });
      await expect(api.read<Select>({
        '@select': '?item',
        '@where': { '@id': 'shopping', '@list': { '?': '?item' } }
      })).resolves.toMatchObject([{ '?item': 'Milk' }]);
    });

    test('selects index from a list', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk'] });
      await expect(api.read<Select>({
        '@select': '?index',
        '@where': { '@id': 'shopping', '@list': { '?index': '?' } }
      })).resolves.toMatchObject([{ '?index': 0 }]);
    });

    test('selects slot from a list', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk'] });
      await expect(api.read<Select>({
        '@select': '?slot',
        '@where': { '@id': 'shopping', '@list': { '?': { '@id': '?slot', '@item': '?' } } }
      })).resolves.toMatchObject([{
        '?slot': { '@id': expect.stringMatching(genIdRegex) }
      }]);
    });

    test('deletes a list with all slots', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk'] });
      // recover the slot ID
      const slotId: string = (<Reference>(await api.read<Select>({
        '@select': '?slot',
        '@where': { '@id': 'shopping', '@list': { '?': { '@id': '?slot', '@item': '?' } } }
      }))[0]['?slot'])['@id'];

      await api.write<Update>({ '@delete': { '@id': 'shopping' } });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toEqual([]);
      await expect(api.read<Describe>({ '@describe': slotId }))
        .resolves.toEqual([]);
    });

    test('deletes a slot by index', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk'] });
      // recover the slot ID
      const slotId: string = (<Reference>(await api.read<Select>({
        '@select': '?slot',
        '@where': { '@id': 'shopping', '@list': { '?': { '@id': '?slot', '@item': '?' } } }
      }))[0]['?slot'])['@id'];

      api.follow(captureUpdate.resolve);
      await api.write<Update>({ '@delete': { '@id': 'shopping', '@list': { 0: '?' } } });

      expect([...(await captureUpdate)['@delete'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          0: { '@id': expect.stringMatching(genIdRegex), '@item': 'Milk', '@index': 0 }
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toEqual([{
          '@id': 'shopping',
          '@type': 'http://m-ld.org/RdfLseq'
        }]);
      await expect(api.read<Describe>({ '@describe': slotId }))
        .resolves.toEqual([]);
    });

    test('move a slot by index', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk', 'Bread', 'Spam'] });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({
        '@delete': {
          '@id': 'shopping', '@list': { 1: { '@id': '?slot', '@item': '?item' } }
        },
        '@insert': {
          '@id': 'shopping', '@list': { 0: { '@id': '?slot', '@item': '?item' } }
        }
      });
      expect([...(await captureUpdate)['@delete'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          // @item is not included in delete for a move
          1: { '@id': expect.stringMatching(genIdRegex), '@index': 1 }
        }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          0: [{ '@id': expect.stringMatching(genIdRegex), '@item': 'Bread', '@index': 0 }]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toEqual([{
          '@id': 'shopping',
          '@type': 'http://m-ld.org/RdfLseq',
          '@list': ['Bread', 'Milk', 'Spam']
        }]);
    });

    test('move a slot by value', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk', 'Bread', 'Spam'] });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({
        '@delete': {
          '@id': 'shopping', '@list': { '?i': { '@id': '?slot', '@item': 'Spam' } }
        },
        '@insert': {
          '@id': 'shopping', '@list': { 0: { '@id': '?slot', '@item': 'Spam' } }
        }
      });
      expect([...(await captureUpdate)['@delete'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          // @item is not included in delete for a move
          2: { '@id': expect.stringMatching(genIdRegex), '@index': 2 }
        }
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@list': {
          0: [{ '@id': expect.stringMatching(genIdRegex), '@item': 'Spam', '@index': 0 }]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toEqual([{
          '@id': 'shopping',
          '@type': 'http://m-ld.org/RdfLseq',
          '@list': ['Spam', 'Milk', 'Bread']
        }]);
      // This checks that the slots have been correctly re-numbered
      await expect(api.read<Select>({
        '@select': ['?0', '?1', '?2'],
        '@where': { '@id': 'shopping', '@list': { 0: '?0', 1: '?1', 2: '?2' } }
      })).resolves.toMatchObject([{
        '?0': 'Spam',
        '?1': 'Milk',
        '?2': 'Bread'
      }]);
    });

    test('change an item', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk', 'Bread'] });
      api.follow(captureUpdate.resolve);
      await api.write<Update>({
        '@delete': { '@id': 'shopping', '@list': { '?1': 'Bread' } },
        '@insert': { '@id': 'shopping', '@list': { '?1': 'Spam' } }
      });
      expect([...(await captureUpdate)['@delete'].graph.values()]).toContainEqual({
        '@id': expect.stringMatching(genIdRegex), '@item': 'Bread'
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': expect.stringMatching(genIdRegex), '@item': 'Spam'
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toEqual([{
          '@id': 'shopping',
          '@type': 'http://m-ld.org/RdfLseq',
          '@list': ['Milk', 'Spam']
        }]);
    });

    test('nested lists are created', async () => {
      api.follow(captureUpdate.resolve);
      await api.write<Subject>({
        '@id': 'shopping', '@list': ['Milk', ['Bread', 'Spam']]
      });
      expect([...(await captureUpdate)['@insert'].graph.values()]).toContainEqual({
        '@id': 'shopping',
        '@type': 'http://m-ld.org/RdfLseq',
        '@list': {
          0: [{
            '@id': expect.stringMatching(genIdRegex), '@item': 'Milk', '@index': 0
          }, {
            '@id': expect.stringMatching(genIdRegex),
            '@item': {
              '@id': expect.stringMatching(genIdRegex),
              '@type': 'http://m-ld.org/RdfLseq',
              '@list': {
                0: [
                  { '@id': expect.stringMatching(genIdRegex), '@item': 'Bread', '@index': 0 },
                  { '@id': expect.stringMatching(genIdRegex), '@item': 'Spam', '@index': 1 }
                ]
              }
            },
            '@index': 1
          }]
        }
      });
      await expect(api.read<Describe>({ '@describe': 'shopping' }))
        .resolves.toMatchObject([{
          '@list': ['Milk', { '@id': expect.stringMatching(genIdRegex) }]
        }]);
    });

    test('cannot force an item to be multi-valued', async () => {
      await api.write<Subject>({ '@id': 'shopping', '@list': ['Milk', 'Bread'] });
      await expect(api.write<Update>({
        // Do not @delete the old value
        '@insert': { '@id': 'shopping', '@list': { '?1': 'Spam' } },
        '@where': { '@id': 'shopping', '@list': { '?1': 'Bread' } }
      })).rejects.toBeDefined();
    });
  });

  describe('state procedures', () => {
    test('reads with a procedure', async done => {
      await api.write<Subject>({ '@id': 'fred', name: 'Fred' });
      api.read(async state => {
        await expect(state.read<Describe>({ '@describe': 'fred' }))
          .resolves.toMatchObject([{ '@id': 'fred', name: 'Fred' }]);
        done();
      });
    });

    test('writes with a procedure', async done => {
      api.write(async state => {
        state = await state.write<Subject>({ '@id': 'fred', name: 'Fred' });
        await expect(state.read<Describe>({ '@describe': 'fred' }))
          .resolves.toMatchObject([{ '@id': 'fred', name: 'Fred' }]);
        done();
      });
    });

    test('write state is predictable', async done => {
      api.write(async state => {
        state = await state.write<Subject>({ '@id': 'fred', age: 40 });
        await expect(state.read<Describe>({
          '@describe': '?id', '@where': { '@id': '?id', age: 40 }
        }))
          // We only expect one person of that age
          .resolves.toMatchObject([{ '@id': 'fred', age: 40 }]);
        done();
      });
      // Immediately make another write which could affect the query
      api.write(state => state.write<Subject>({ '@id': 'wilma', age: 40 }));
    });

    test('handler state follows writes', async done => {
      let hadFred = false;
      api.read(async state => {
        await expect(state.read<Describe>({
          '@describe': '?id', '@where': { '@id': '?id', age: 40 }
        })).resolves.toEqual([]);
      }, async (_, state) => {
        if (!hadFred) {
          await expect(state.read<Describe>({
            '@describe': '?id', '@where': { '@id': '?id', age: 40 }
          })).resolves.toMatchObject([{ '@id': 'fred', age: 40 }]);
          hadFred = true;
        } else {
          await expect(state.read<Describe>({
            '@describe': '?id', '@where': { '@id': '?id', age: 40 }
          })).resolves.toMatchObject([{ '@id': 'wilma', age: 40 }]);
          done();
        }
      });
      api.write(async state => {
        state = await state.write<Subject>({ '@id': 'fred', age: 40 });
        await state.write<Subject>({
          '@delete': { '@id': 'fred', age: 40 },
          '@insert': { '@id': 'wilma', age: 40 }
        });
      });
    });
  });
});

