import {
  AnimationOptions,
  AttributeSetBase,
  Mark,
  MarkAttributes,
  SimpleAnimationOptions,
} from './mark';
import { TimeProvider, getAllMethodNames, makeTimeProvider } from './utils';
import {
  AnimationCurve,
  Interpolator,
  PreloadableAnimator,
  curveEaseInOut,
} from './animator';
import { Advanceable } from './ticker';

type RenderGroupOptions = {
  timeProvider?: TimeProvider;
  lazyUpdates?: boolean;
  animationDuration?: number;
  animationCurve?: AnimationCurve;
};

type GroupOptions<T, AttributeSet extends AttributeSetBase> = {
  [P in keyof T]: T[P] | ((mark: Mark<AttributeSet>, i: number) => T[P]);
};

export type GroupSimpleAnimationOptions<AttributeSet extends AttributeSetBase> =
  GroupOptions<SimpleAnimationOptions, AttributeSet>;

export type GroupAnimationOptions<
  AttributeSet extends AttributeSetBase,
  ValueType
> = GroupOptions<AnimationOptions<ValueType>, AttributeSet>;

/**
 * Returns an options object suitable for passing to an individual mark by
 * evaluating any option that is provided as a function.
 *
 * @param options A grouped options object, where some key values may be functions.
 * @param mark The mark to evaluate the options for
 * @param i The index of the mark to evaluate the options for
 * @returns Options for the provided mark
 */
function _evaluateGroupOptions<T, AttributeSet extends AttributeSetBase>(
  options: GroupOptions<T, AttributeSet>,
  mark: Mark<AttributeSet>,
  i: number
): T {
  return Object.fromEntries(
    Object.entries(options).map(([key, val]) => [
      key,
      typeof val === 'function' ? val(mark, i) : val,
    ])
  ) as T;
}

/**
 * Keeps track of a set of marks. This is helpful to track which
 * marks are being animated, thereby saving on computation in each
 * run loop.
 */
export class MarkRenderGroup<
  AttributeSet extends AttributeSetBase = MarkAttributes
> implements Advanceable
{
  private timeProvider: TimeProvider = null;

  /**
   * The set of marks that this group contains. All marks have the same set
   * of attributes.
   */
  private marks: Mark<AttributeSet>[];
  /**
   * Controls whether the mark group iterates over the entire set of marks in
   * every call to `advance()`. If set to `true`, only the marks that have
   * been explicitly changed through a call to `set...` or `animate...` will
   * be advanced. The default is `false`.
   *
   * @note Even if lazy updates are turned on, computed mark attributes will
   * still reflect updated values when their value functions change. This means
   * that if a drawing loop always iterates over all marks, they will all be
   * updated even if only a subset has `advance` called.
   */
  public lazyUpdates: boolean = false;

  private marksByID: Map<any, Mark<AttributeSet>>;

  // Marks that have an active animation
  private animatingMarks: Set<Mark<AttributeSet>> = new Set();

  // Marks updated in this frame
  private updatedMarks: Set<Mark<AttributeSet>> = new Set();

  private preloadableProperties: Set<keyof AttributeSet> = new Set();

  private _forceUpdate = false;
  private _markListChanged = false;

  private _defaultDuration: number;
  private _defaultCurve: AnimationCurve;

  /**
   * @param marks The set of marks that this group should manage, all including
   *  the same set of attributes.
   * @param opts Options for the mark group (see {@link configure})
   */
  constructor(
    marks: Mark<AttributeSet>[] = [],
    opts: RenderGroupOptions = {
      animationDuration: 1000,
      animationCurve: curveEaseInOut,
    }
  ) {
    this.timeProvider = makeTimeProvider();
    this.lazyUpdates = false;
    this._defaultDuration = 1000;
    this._defaultCurve = curveEaseInOut;
    this.configure(opts);

    this.marks = marks;
    this.marksByID = new Map();
    this.marks.forEach((m) => {
      if (this.marksByID.has(m.id)) {
        console.error(`ID '${m.id}' is duplicated in mark render group`);
        return;
      }
      this.marksByID.set(m.id, m);
      this._configureMark(m);
    });
  }

  /**
   * Applies configuration options to the render group.
   *
   * @param opts Options for the mark group, including:
   *  - `timeProvider`: a shared `TimeProvider` object to be used among all
   *    marks. By default a new time provider is created.
   *  - `lazyUpdates`: whether to iterate over only the updated marks in each
   *    iteration, or every mark. The default is `false`, meaning every mark
   *    is updated every iteration.
   *  - `animationDuration`: the default animation duration in milliseconds
   *    (default 1000)
   *  - `animationCurve`: the default animation curve to use (default ease-in-out)
   * @returns this render group
   */
  configure(opts: RenderGroupOptions): MarkRenderGroup<AttributeSet> {
    if (opts.timeProvider !== undefined) this.timeProvider = opts.timeProvider;
    if (opts.lazyUpdates !== undefined) this.lazyUpdates = opts.lazyUpdates;
    if (opts.animationDuration !== undefined)
      this._defaultDuration = opts.animationDuration;
    if (opts.animationCurve !== undefined)
      this._defaultCurve = opts.animationCurve;
    if (!!this.marks) this.getMarks().forEach((m) => this._configureMark(m));
    return this;
  }

  /**
   * Configures a mark's callbacks and default properties.
   * @param m the mark to configure
   */
  _configureMark(m: Mark<AttributeSet>) {
    m.setTimeProvider(this.timeProvider);
    m.configure({
      animationDuration: this._defaultDuration,
      animationCurve: this._defaultCurve,
    });
    m.addListener((mark, attrName, animated) => {
      this.updatedMarks.add(mark);
      if (!this.preloadableProperties.has(attrName) && animated)
        this.animatingMarks.add(mark);
    });
  }

  /**
   * Triggers the mark group to run an update even when no marks have been
   * explicitly updated. This only changes behavior when `lazyUpdates` is
   * set to `true`.
   *
   * @returns this render group
   *
   * @see lazyUpdates
   */
  forceUpdate(): MarkRenderGroup<AttributeSet> {
    this._forceUpdate = true;
    return this;
  }

  /**
   * @returns The set of marks that this render group knows about
   */
  getMarks(): Mark<AttributeSet>[] {
    return this.marks;
  }

  /**
   * Declares that the given attribute will only ever use preloadable animations.
   * Preloadable attributes will not be counted in calls to {@link marksAnimating}, and
   * only initial changes will be reflected in {@link marksChanged}. This permits
   * faster rendering by computing animations in shaders, and only computing
   * them on the CPU when explicitly requested through a call to {@link Attribute.get()}.
   * Note that animations to these properties must be created through
   * {@link animatePreload}, {@link animateComputed}, or {@link animateOne} with a
   * {@link PreloadableAnimator}.
   *
   * @param attrName the attribute to register
   * @returns this render group
   */
  registerPreloadableProperty(
    attrName: keyof AttributeSet
  ): MarkRenderGroup<AttributeSet> {
    this.preloadableProperties.add(attrName);
    return this;
  }

  /**
   * Advances all of the marks (or the updated marks, if `lazyUpdates` is set
   * to `true`) and returns whether a redraw is needed.
   *
   * @param dt The time elapsed since the last call to `advance`.
   *
   * @returns `true` if marks have changed and a redraw is needed, or `false`
   *  otherwise.
   */
  advance(dt: number): boolean {
    this.timeProvider.advance(dt);

    let marksToUpdate = this.lazyUpdates
      ? [...this.animatingMarks, ...this.updatedMarks]
      : this.getMarks();
    this.updatedMarks = new Set();
    if (
      marksToUpdate.length == 0 &&
      !this._forceUpdate &&
      !this._markListChanged
    )
      return false;

    for (let mark of marksToUpdate) {
      if (!mark.advance()) {
        this.animatingMarks.delete(mark);
      }
    }

    this._forceUpdate = false;
    this._markListChanged = false;

    return true;
  }

  /**
   * @returns whether any mark properties have been changed since the last
   * `advance()` call, or if any animations have been added. If an animation
   * is on a non-preloadable property, this also returns `true`.
   */
  marksChanged(): boolean {
    return (
      this.updatedMarks.size > 0 || this._forceUpdate || this._markListChanged
    );
  }

  /**
   * @returns whether any marks are currently animating, excluding any marks that
   *  have a preloadable animation (since these are not regularly updated)
   */
  marksAnimating(): boolean {
    return this.animatingMarks.size > 0;
  }

  /**
   * Animates all marks to the value defined by the given function.
   *
   * @param attrName the attribute name to update
   * @param finalValueFn a function that takes a mark and its index, and returns
   *  a value or value function for that mark
   * @param options options for the animation, including the duration and curve
   *  to use
   * @returns this render group
   */
  animateTo<
    K extends keyof AttributeSet,
    AttributeType extends AttributeSet[K]
  >(
    attrName: K,
    finalValueFn:
      | AttributeType['value']
      | ((
          mark: Mark<AttributeSet>,
          i: number
        ) =>
          | AttributeType['value']
          | ((
              computeArg: AttributeType['computeArg']
            ) => AttributeType['value'])),
    options: GroupSimpleAnimationOptions<AttributeSet> = {}
  ): MarkRenderGroup<AttributeSet> {
    let preloadable = this.preloadableProperties.has(attrName);
    // this.updatedMarks = new Set(this.getMarks());

    if (preloadable) {
      this.forEach((mark, i) => {
        let markOptions = _evaluateGroupOptions(options, mark, i);
        let duration =
          markOptions.duration === undefined
            ? this._defaultDuration
            : markOptions.duration;
        mark.animate(
          attrName,
          new PreloadableAnimator(
            typeof finalValueFn === 'function'
              ? (finalValueFn as Function)(mark, i)
              : finalValueFn,
            duration
          ).withDelay(markOptions.delay || 0)
        );
      });
    } else {
      // this.animatingMarks = new Set(this.getMarks());
      this.forEach((mark, i) => {
        mark.animateTo(
          attrName,
          typeof finalValueFn === 'function'
            ? (finalValueFn as Function)(mark, i)
            : finalValueFn,
          _evaluateGroupOptions(options, mark, i)
        );
      });
    }

    return this;
  }

  /**
   * Animates all marks to their new computed value, or uses a custom
   * interpolator.
   *
   * @param attrName the attribute name to update
   * @param options options for the animation, including the duration and curve
   *  to use. The `interpolator` option takes a function that allows you to
   *  specify a custom interpolator for each mark.
   * @returns this render group
   */
  animate<
    K extends keyof AttributeSet,
    ValueType extends AttributeSet[K]['value']
  >(
    attrName: K,
    options: GroupAnimationOptions<AttributeSet, ValueType> = {}
  ): MarkRenderGroup<AttributeSet> {
    let preloadable = this.preloadableProperties.has(attrName);
    if (preloadable && !!options.interpolator) {
      console.error(
        'Cannot apply custom interpolator function on preloadable property.'
      );
      return this;
    }

    this.forEach((mark, i) => {
      let markOptions = _evaluateGroupOptions(options, mark, i);
      if (preloadable) {
        let duration =
          markOptions.duration === undefined
            ? this._defaultDuration
            : markOptions.duration;
        let newValue = mark.data(attrName);
        mark.animate(
          attrName,
          new PreloadableAnimator(newValue, duration).withDelay(
            markOptions.delay || 0
          )
        );
      } else {
        mark.animate(attrName, markOptions);
      }
    });

    return this;
  }

  /**
   * Updates the value of the given attribute in every mark.
   *
   * @param attrName the attribute name to update
   * @param newValueFn an optional function that takes a mark and its index, and
   *  returns the new value or value function for that mark. If not provided,
   *  the attribute values will be recomputed using the existing value or value
   *  function.
   * @returns this render group
   */
  update<K extends keyof AttributeSet, AttributeType extends AttributeSet[K]>(
    attrName: K,
    newValueFn:
      | AttributeType['value']
      | ((
          mark: Mark<AttributeSet>,
          i: number
        ) =>
          | AttributeType['value']
          | ((
              computeArg: AttributeType['computeArg']
            ) => AttributeType['value']))
      | undefined = undefined
  ): MarkRenderGroup<AttributeSet> {
    this.forEach((mark, i) => {
      mark.setAttr(
        attrName,
        newValueFn === undefined
          ? undefined
          : typeof newValueFn === 'function'
          ? (newValueFn as Function)(mark, i)
          : newValueFn
      );
    });
    return this;
  }

  /**
   * Waits for the animations on the specified attribute name(s) to complete.
   *
   * @param attrNames An attribute name or array of attribute names to wait for.
   * @param rejectOnCancel If true (default), reject the promise if any animation is
   *  canceled or superseded. If false, resolve the promise in this case.
   * @returns a `Promise` that resolves when all the animations for the given
   *  attributes have completed, and rejects if any of their animations are
   *  canceled or superseded by another animation (unless `rejectOnCancel` is set
   *  to `false`). If none of the listed attributes have an active animation,
   *  the promise resolves immediately.
   */
  wait<K extends keyof AttributeSet>(
    attrNames: K | K[],
    rejectOnCancel: boolean = true
  ): Promise<any> {
    return Promise.all(
      this.map((mark) => mark.wait(attrNames, rejectOnCancel))
    );
  }

  /**
   * Retrieves the mark with the given ID, or undefined if it does not exist.
   * @param id the ID of the mark to search for
   * @returns the `Mark` instance with the given ID or undefined if it doesn't
   * exist
   */
  getMarkByID(id: any): Mark<AttributeSet> | undefined {
    return this.marksByID.get(id);
  }

  forEach(
    callbackfn: (
      value: Mark<AttributeSet>,
      index: number,
      array: Mark<AttributeSet>[]
    ) => void | any
  ) {
    this.getMarks().forEach(callbackfn);
  }

  map<T>(
    mapper: (
      value: Mark<AttributeSet>,
      index: number,
      array: Mark<AttributeSet>[]
    ) => T
  ): T[] {
    return this.getMarks().map(mapper);
  }

  /**
   * Filters the marks so that a subsequent action can be performed.
   *
   * @example ```markSet.filter([...]).animateTo("alpha", 0.0)
   * @param filterer Predicate function
   * @returns a view of the render group with only a subset of the marks
   */
  filter(
    filterer: (
      value: Mark<AttributeSet>,
      index: number,
      array: Mark<AttributeSet>[]
    ) => boolean
  ): MarkRenderGroup<AttributeSet> {
    // Create a proxy object that replicates the behavior of the render group
    // exactly, but swaps out the marks and mark ID mapping before every method
    // call.
    let proxy = Object.assign({}, this);
    let newMarkSet = this.getMarks().filter(filterer);
    Object.keys(this).forEach((key) => {
      proxy[key] = this[key];
    });
    proxy.marks = newMarkSet;
    proxy.marksByID = new Map();
    newMarkSet.forEach((m) => {
      proxy.marksByID.set(m.id, m);
    });

    getAllMethodNames(this).forEach((methodName) => {
      if (methodName == 'getMarks') {
        proxy[methodName] = () => {
          return newMarkSet;
        };
      } else {
        proxy[methodName] = (...args) => {
          let oldMarks = this.getMarks();
          this.marks = newMarkSet;
          let ret = this[methodName](...args);
          this.marks = oldMarks;
          if (ret === this) return proxy;
          return ret;
        };
      }
    });
    return proxy as MarkRenderGroup<AttributeSet>;
  }

  /**
   * Notifies every mark that the transform for the given attribute has changed.
   *
   * @param attrName the attribute whose transform has changed
   * @returns this render group
   *
   * @see Attribute.updateTransform
   */
  updateTransform(attrName: keyof AttributeSet): MarkRenderGroup<AttributeSet> {
    this.getMarks().forEach((m) => m.updateTransform(attrName));
    return this;
  }

  /**
   * Adds a mark to the render group.
   *
   * @param mark the mark to add
   * @returns this render group
   */
  addMark(mark: Mark<AttributeSet>): MarkRenderGroup<AttributeSet> {
    if (this.marksByID.has(mark.id)) {
      console.error('Attempted to add mark with ID that exists:', mark.id);
      return this;
    }
    this.marks.push(mark);
    this.marksByID.set(mark.id, mark);
    this._configureMark(mark);
    this._markListChanged = true;
  }

  /**
   * Removes a mark from the render group.
   *
   * @param mark the mark to remove
   * @returns this render group
   */
  removeMark(mark: Mark<AttributeSet>): MarkRenderGroup<AttributeSet> {
    let idx = this.marks.indexOf(mark);
    if (idx < 0) {
      console.warn('Attempted to remove mark that does not exist');
      return this;
    }
    this.marks.splice(idx, 1);
    this.marksByID.delete(mark.id);
    this._markListChanged = true;
  }
}

export function createRenderGroup<AttributeSet extends AttributeSetBase>(
  marks: Mark<AttributeSet>[] = []
): MarkRenderGroup<AttributeSet> {
  return new MarkRenderGroup(marks);
}
