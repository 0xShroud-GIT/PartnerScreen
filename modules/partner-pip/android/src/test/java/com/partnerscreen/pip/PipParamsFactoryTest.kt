package com.partnerscreen.pip

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 35])
class PipParamsFactoryTest {
  @Test
  fun actualVideoGeometryBecomesPictureInPictureAspectRatio() {
    val landscape = PipParamsFactory.create(1280, 720).aspectRatio
    assertEquals(16, landscape?.numerator)
    assertEquals(9, landscape?.denominator)

    val portrait = PipParamsFactory.create(720, 1280).aspectRatio
    assertEquals(9, portrait?.numerator)
    assertEquals(16, portrait?.denominator)
  }

  @Test
  fun geometryIsBoundedBeforeCreatingAndroidParams() {
    val params = PipParamsFactory.create(9_999, 1).aspectRatio
    assertEquals(1920, params?.numerator)
    assertEquals(1, params?.denominator)
  }
}
