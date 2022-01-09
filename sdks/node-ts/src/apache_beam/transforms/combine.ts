import { GroupByKey, ParDo, CombineFn, PTransform, PCollection, DoFn } from "../base";
import {BoundedWindow, Instant, KV, PaneInfo} from '../values'
import {GroupBy, keyBy} from './core'

export function countGlobally() {
    return new CombineGlobally(new CountFn());
}

export function countPerKey() {
    return new CombinePerKey(new CountFn())
}

export function combineGlobally<InputT, AccT, OutputT>(combineFn: CombineFn<InputT, AccT, OutputT>): CombineGlobally<InputT, AccT, OutputT> {
    return new CombineGlobally(combineFn);
}

export function combinePerKey<InputT, AccT, OutputT>(combineFn: CombineFn<InputT, AccT, OutputT>): CombinePerKey<InputT, AccT, OutputT> {
    return new CombinePerKey(combineFn);
}


// TODO(pabloem): Consider implementing Combines as primitives rather than with PArDos.
class CombinePerKey<InputT, AccT, OutputT> extends PTransform<PCollection<KV<any, InputT>>, PCollection<KV<any, OutputT>>> {
    combineFn: CombineFn<InputT, AccT, OutputT>
    constructor(combineFn: CombineFn<InputT, AccT, OutputT>) {
        super();
        this.combineFn = combineFn;
    }

    expand(input: PCollection<KV<any, InputT>>) {
        return input.apply(new ParDo(new PreShuffleCombineDoFn(this.combineFn)))
            .apply(new GroupByKey())
            .apply(new ParDo(new PostShuffleCombineDoFn(this.combineFn)))
    }
}

class CombineGlobally<InputT, AccT, OutputT> extends PTransform<PCollection<InputT>, PCollection<OutputT>> {
    combineFn: CombineFn<InputT, AccT, OutputT>
    constructor(combineFn: CombineFn<InputT, AccT, OutputT>) {
        super();
        this.combineFn = combineFn;
    }

    expand(input: PCollection<InputT>) {
        return input
        .map(elm => ({key: "", value: elm}))
            .apply(new ParDo(new PreShuffleCombineDoFn(this.combineFn)))
            .apply(new GroupByKey())
            .apply(new ParDo(new PostShuffleCombineDoFn(this.combineFn)))
            .map(elm => elm.value)
    }
}

class CountFn implements CombineFn<any, number, number> {
    createAccumulator() {
        return 0
    }
    addInput(acc: number, i: any) {
        return acc + 1
    }
    mergeAccumulators(accumulators: number[]) {
        return accumulators.reduce((prev, current) => prev + current)
    }
    extractOutput(acc: number) {
        return acc
    }
    
}

class PreShuffleCombineDoFn<InputT, AccumT> extends DoFn<KV<any, InputT>, KV<any, AccumT>> {
    accums: Map<any, AccumT> = new Map()
    combineFn: CombineFn<InputT, AccumT, any>

    constructor(combineFn: CombineFn<InputT, AccumT, any>) {
        super();
        this.combineFn = combineFn;
    }

    process(elm: KV<any, InputT>) {
        if (!this.accums[elm.key]) {
            this.accums[elm.key] = this.combineFn.createAccumulator();
        }
        this.accums[elm.key] = this.combineFn.addInput(this.accums[elm.key], elm.value);
    }

    *finishBundle() {
        for (let k in this.accums) {
            yield {
                value: {'key': k, 'value': this.accums[k]},
                windows: <Array<BoundedWindow>><unknown>undefined,
                pane: <PaneInfo><unknown>undefined,
                timestamp: <Instant><unknown>undefined
            }
        }
    }
}

class PostShuffleCombineDoFn<AccumT, OutputT> extends DoFn<KV<any, Iterable<AccumT>>, KV<any, OutputT>> {
    accums: Map<any, [AccumT]> = new Map()
    combineFn: CombineFn<any, AccumT, OutputT>

    constructor(combineFn: CombineFn<any, AccumT, OutputT>) {
        super();
        this.combineFn = combineFn;
    }

    process(elm: KV<any, Iterable<AccumT>>) {
        if (!this.accums[elm.key]) {
            this.accums[elm.key] = []
        }
        this.accums[elm.key].push(elm.value[0])
    }

    *finishBundle() {
        for (let k in this.accums) {
        yield {
            value: {'key': k, 'value': this.combineFn.extractOutput(this.combineFn.mergeAccumulators(this.accums[k]))},
            windows: <Array<BoundedWindow>><unknown>undefined,
            pane: <PaneInfo><unknown>undefined,
            timestamp: <Instant><unknown>undefined
        }
    }
    }
}